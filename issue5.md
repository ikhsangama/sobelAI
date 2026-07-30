# Task 5 — `selectStrategy.ts` + tests + the `strategy_rules` seed

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 5:

> `selectStrategy.ts` + tests + `strategy_rules` seed (§6.3, 10 rows — `cooldown_active` is a post-selection function, not a row). Test every row fires when expected and loses when outranked; test the post-selection cooldown check separately; test that a zero-touch `new`+`meta_ad` lead reaches `instant_qualify` rather than being swallowed by `warm_human_handles`.

**Outcome:** the priority-ordered rules table that turns a `LeadState` into one of seven strategies — the deterministic half of the pipeline's "when and whether" decision. The LLM still hasn't entered the picture.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `guardrail()` G1–G5 | Task 6 |
| `MockProvider`, `packages/llm` | Task 7 |
| `generate-drafts` (which calls this and builds the trace) | Task 11 |
| Anything that writes `leads.state` | Task 11 |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

---

## Read this before you start

### The one thing that makes this task harder than task 4

`strategy_rules.match` is a **`jsonb` column** (see `0001_init.sql`), but §6.3 writes the ten match conditions as *prose expressions* — `state in ['cold','dormant'] && fact_gaps.length > 0`. Nothing in the contract says what those look like as JSON, or how `selectStrategy()` evaluates them. **That is the central spec gap of this task**, and step 1 resolves it with a deliberately closed, six-key schema rather than a general expression language. Read step 1 before writing any code.

### Six traps

**Trap 1 — 10 rows, not 11. `cooldown_active` is not a rule.**
An earlier draft of the contract had `cooldown_active` competing at priority 85 with the match `days_since_outbound < rule_cooldown` against its own `cooldown_days: 0` — i.e. `days_since_outbound < 0`, always false, and circular besides (you can't know whose cooldown applies until a rule has already won). It was deleted. `types.ts` already encodes this: `StrategyRuleRow.name` is `SeededRuleName` (the 10 real rows), while the wider `RuleName` — which adds `cooldown_active` and `no_rule_matched` — exists only for `trace.rule_fired`. **If you find yourself widening a type to make a seed row compile, the type is right and the row is wrong.**

**Trap 2 — cooldown is checked *after* a winner is picked, not during matching.**
Two steps, in order: (1) highest-priority matching rule wins; (2) *then* if `days_since_outbound < winner.cooldown_days`, the result becomes `suppress` with `rule_fired = 'cooldown_active'` and `suppressed_by_cooldown = winner.name`. Folding the cooldown into the match conditions recreates the circularity that got the row deleted.

**Trap 3 — `warm_human_handles` needs `&& touch_count > 0`. It is not `state == 'warm'` alone.**
Without the second clause it suppresses a fresh Meta ad lead before `new_ad_lead` can be evaluated, because that lead's first inbound message makes `classify()` return `warm` immediately. The clause means "the AI stays out of a conversation *it is already part of*." See trap 4 — this is only half the story.

**Trap 4 — a Meta ad lead who submits the form reaches NO rule. Implement it anyway; do not "fix" it.**
This is a real gap in the contract and you will trip over it writing the tests, so know it up front. Traced against the shipped `classify()`:

| Lead | `state` | `touch_count` | Result |
|---|---|---|---|
| `meta_ad`, form submitted (→ an inbound message exists) | `warm` | 0 | **`no_rule_matched`** |
| `meta_ad`, no inbound message yet | `new` | 0 | `new_ad_lead` → `instant_qualify` ✓ |

`warm_human_handles` correctly stands down (`touch_count > 0` is false), but `new_ad_lead` requires `state == 'new'` and the state is `warm` — so nothing matches. §6.3's fix removed a wrong *suppression*; it did not make `instant_qualify` reachable for the case it describes.

**Do not change the rule table to paper over this** — contract rule 1 forbids inventing business logic, and the table is specified literally. Instead: implement §6.3 exactly, write the §11-mandated test in the form that *is* satisfiable (the no-inbound row above), and add a second test pinning the `warm`/zero-touch case's actual `no_rule_matched` behaviour with a comment marking it. Step 4 gives both tests. It also belongs in the README's founder questions — "should a submitted ad form count as an inbound message for state purposes, or should `new_ad_lead` key off `touch_count == 0 && source == 'meta_ad'` regardless of state?" is exactly the kind of question this build is meant to surface.

**Trap 5 — an unknown key in `match` must throw, not be ignored.**
A silently-ignored typo (`state_id` instead of `state_in`) turns a rule into one that matches *everything*, because a schema with no recognised constraints is vacuously satisfied. For a priority-100 suppression rule that would silence the entire queue. Loud failure is correct here.

**Trap 6 — `selectStrategy()` stays pure.** No DB reads, no `Date.now()`. Rules, agent, fact gaps, and `now` all arrive as arguments — same discipline as `classify()`, contract rule 3.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.

---

## Step 1 — The `match` schema (read before coding)

`match` is a JSON object. **Every key present is ANDed.** Keys are drawn from a closed set of exactly six — this is not an expression language and must not become one.

| Key | Type | Meaning |
|---|---|---|
| `state_in` | `LeadState[]` | lead's state is one of these |
| `source_eq` | `LeadSource` | lead's source equals this |
| `snoozed` | `boolean` | whether `snooze_until` is in the future |
| `touch_count` | numeric condition | compares `lead.touch_count` |
| `fact_gaps_len` | numeric condition | compares `factGaps.length` |
| `days_silent` | numeric condition | compares days since the lead last spoke |

A **numeric condition** is an object of operators — `eq`, `gt`, `gte`, `lt`, `lte` — each ANDed. Its right-hand side is either a plain number or a reference to the agent's touch cap:

```jsonc
{ "gte": 14 }                                    // days_silent >= 14
{ "gte": { "agent": "max_touches" } }            // touch_count >= agent.max_touches
{ "eq":  { "agent": "max_touches", "offset": -1 } }  // touch_count == max_touches - 1
```

That `offset` exists solely for `last_chance`, whose §6.3 condition is `touch_count == agent.max_touches - 1`.

**Why a closed schema rather than hardcoded predicates.** The architectural claim this build is making is that the rules table lives in Postgres and is *editable without a deploy* — you can retune a threshold, disable a rule, or reorder priorities in SQL. Hardcoding the ten predicates in TypeScript would reduce that to "priority and enabled are editable," which is a materially weaker claim. Six keys and five operators is about forty lines to evaluate and is honestly describable in one sentence.

**Why not a general DSL.** §4 already rejected one condition-language (`ELIGIBILITY_TOPICS.triggerWhen`) as scope this repo doesn't need. That reasoning holds for a *parser*; it doesn't extend to this column, because unlike `triggerWhen`, `strategy_rules.match` genuinely has a consumer — `selectStrategy()` must evaluate something. The honest middle is a fixed schema with no parsing.

Mark the whole thing `// SPEC-GAP:` in the source. State plainly in the README that *values* are editable without deploy but *new predicate kinds* are not.

---

## Step 2 — `packages/core/src/selectStrategy.ts`

Create the file with exactly this content:

```ts
import type {
  AgentRow,
  LeadRow,
  LeadSource,
  LeadState,
  RuleName,
  SeededRuleName,
  Strategy,
  StrategyRuleRow,
} from './types'
import { classify, diffDays } from './classify'

/**
 * A rule as `selectStrategy` consumes it. `id` is the only column the
 * selector never reads, so omitting it lets DEFAULT_STRATEGY_RULES below
 * double as both the canonical rule definition and valid test input.
 * A real `StrategyRuleRow` from the database is assignable to this.
 */
export type StrategyRule = Omit<StrategyRuleRow, 'id'>

// ---------------------------------------------------------------------------
// The `match` schema
//
// // SPEC-GAP: §6.3 writes the ten match conditions as prose expressions
// (`state in ['cold','dormant'] && fact_gaps.length > 0`) while the schema
// stores `match` as jsonb, and nothing in the contract bridges the two. This
// is a deliberately closed six-key schema, not an expression language: every
// key present is ANDed, and an unrecognised key throws rather than being
// ignored. It keeps the "rules are editable in SQL without a deploy" claim
// true for values and thresholds; adding a new *kind* of predicate still
// needs a code change, and the README says so.
// ---------------------------------------------------------------------------

/** Right-hand side of a numeric comparison: a literal, or the agent's cap. */
export type NumOperand = number | { agent: 'max_touches'; offset?: number }

/** Operators are ANDed. `{ gte: 1, lte: 3 }` means 1 <= x <= 3. */
export type NumCondition = Partial<Record<'eq' | 'gt' | 'gte' | 'lt' | 'lte', NumOperand>>

export interface RuleMatch {
  state_in?: LeadState[]
  source_eq?: LeadSource
  snoozed?: boolean
  touch_count?: NumCondition
  fact_gaps_len?: NumCondition
  days_silent?: NumCondition
}

const MATCH_KEYS = [
  'state_in',
  'source_eq',
  'snoozed',
  'touch_count',
  'fact_gaps_len',
  'days_silent',
] as const

const NUM_OPS = ['eq', 'gt', 'gte', 'lt', 'lte'] as const

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface EvalContext {
  state: LeadState
  source: LeadSource
  snoozed: boolean
  touch_count: number
  fact_gaps_len: number
  days_silent: number
  max_touches: number
}

function resolveOperand(operand: NumOperand, ctx: EvalContext): number {
  if (typeof operand === 'number') return operand
  return ctx.max_touches + (operand.offset ?? 0)
}

function compareNum(
  actual: number,
  condition: NumCondition,
  ctx: EvalContext,
  rule: SeededRuleName,
  field: string,
): boolean {
  for (const [op, operand] of Object.entries(condition)) {
    if (!(NUM_OPS as readonly string[]).includes(op)) {
      throw new Error(
        `strategy_rules.match: unknown operator "${op}" on ${field} of rule ` +
          `"${rule}". Allowed: ${NUM_OPS.join(', ')}.`,
      )
    }
    const rhs = resolveOperand(operand as NumOperand, ctx)
    const ok =
      op === 'eq' ? actual === rhs
      : op === 'gt' ? actual > rhs
      : op === 'gte' ? actual >= rhs
      : op === 'lt' ? actual < rhs
      : actual <= rhs
    if (!ok) return false
  }
  return true
}

/** Trap 5: an unrecognised key would make a rule vacuously match everything. */
function parseMatch(raw: Record<string, unknown>, rule: SeededRuleName): RuleMatch {
  for (const key of Object.keys(raw)) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `strategy_rules.match: unknown key "${key}" on rule "${rule}". ` +
          `Allowed: ${MATCH_KEYS.join(', ')}.`,
      )
    }
  }
  return raw as RuleMatch
}

function matches(m: RuleMatch, ctx: EvalContext, rule: SeededRuleName): boolean {
  if (m.state_in && !m.state_in.includes(ctx.state)) return false
  if (m.source_eq !== undefined && ctx.source !== m.source_eq) return false
  if (m.snoozed !== undefined && ctx.snoozed !== m.snoozed) return false
  if (m.touch_count && !compareNum(ctx.touch_count, m.touch_count, ctx, rule, 'touch_count'))
    return false
  if (m.fact_gaps_len && !compareNum(ctx.fact_gaps_len, m.fact_gaps_len, ctx, rule, 'fact_gaps_len'))
    return false
  if (m.days_silent && !compareNum(ctx.days_silent, m.days_silent, ctx, rule, 'days_silent'))
    return false
  return true
}

/** §6.3: "Ties are impossible — priorities are unique." The table is editable, so check. */
function assertUniquePriorities(rules: StrategyRule[]): void {
  const seen = new Map<number, SeededRuleName>()
  for (const rule of rules) {
    const clash = seen.get(rule.priority)
    if (clash !== undefined) {
      throw new Error(
        `strategy_rules: priority ${rule.priority} is used by both "${clash}" and ` +
          `"${rule.name}". §6.3 requires unique priorities so ties are impossible.`,
      )
    }
    seen.set(rule.priority, rule.name)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SelectStrategyInput {
  lead: LeadRow
  agent: AgentRow
  rules: StrategyRule[]
  /** From factGaps() in facts.ts — passed in, so this stays pure. */
  factGaps: string[]
  now: Date
}

export interface RuleEvaluation {
  name: SeededRuleName
  matched: boolean
}

export interface SelectStrategyResult {
  state: LeadState
  strategy: Strategy
  rule_fired: RuleName
  /** null for `cooldown_active` and `no_rule_matched` — neither is a table row. */
  rule_priority: number | null
  rules_evaluated: RuleEvaluation[]
  /** Set only when a cooldown blocked an otherwise-winning rule. */
  suppressed_by_cooldown?: SeededRuleName
}

/**
 * Pure. Rules, agent, fact gaps and `now` are all injected — contract rule 3.
 *
 * Calls `classify()` itself rather than reading `lead.state`, because that
 * column is a denormalized cache written only by generate-drafts (§6.1). One
 * call site means the state used for rule matching cannot drift from the
 * state reported in the trace.
 */
export function selectStrategy(input: SelectStrategyInput): SelectStrategyResult {
  const { lead, agent, rules, factGaps, now } = input

  const state = classify(lead, now)

  /**
   * // SPEC-GAP: §6.3 uses `days_silent` for `listing_hook` but never defines
   * it. Days since the lead last spoke, falling back to creation when they
   * never have — the same shape classify() uses for its own null-inbound
   * branch, so the two agree about what "silence" means.
   */
  const days_silent = lead.last_inbound_at
    ? diffDays(now, lead.last_inbound_at)
    : diffDays(now, lead.created_at)

  const ctx: EvalContext = {
    state,
    source: lead.source,
    snoozed:
      lead.snooze_until !== null && new Date(lead.snooze_until).getTime() > now.getTime(),
    touch_count: lead.touch_count,
    fact_gaps_len: factGaps.length,
    days_silent,
    max_touches: agent.max_touches,
  }

  const enabled = rules.filter((r) => r.enabled)
  assertUniquePriorities(enabled)

  // Every enabled rule is evaluated, not just up to the first hit — the trace
  // panel (§9) shows which rules were considered and which matched.
  const byPriority = [...enabled].sort((a, b) => b.priority - a.priority)
  const rules_evaluated: RuleEvaluation[] = []
  let winner: StrategyRule | null = null

  for (const rule of byPriority) {
    const matched = matches(parseMatch(rule.match, rule.name), ctx, rule.name)
    rules_evaluated.push({ name: rule.name, matched })
    if (matched && winner === null) winner = rule
  }

  if (winner === null) {
    return {
      state,
      strategy: 'suppress',
      rule_fired: 'no_rule_matched',
      rule_priority: null,
      rules_evaluated,
    }
  }

  // Trap 2: post-selection, never part of matching. A lead that has never been
  // messaged has no cooldown to be inside of.
  const daysSinceOutbound = lead.last_outbound_at ? diffDays(now, lead.last_outbound_at) : null
  if (daysSinceOutbound !== null && daysSinceOutbound < winner.cooldown_days) {
    return {
      state,
      strategy: 'suppress',
      rule_fired: 'cooldown_active',
      rule_priority: null,
      rules_evaluated,
      suppressed_by_cooldown: winner.name,
    }
  }

  return {
    state,
    strategy: winner.strategy,
    rule_fired: winner.name,
    rule_priority: winner.priority,
    rules_evaluated,
  }
}

// ---------------------------------------------------------------------------
// The 10 seeded rows (§6.3), canonical definition.
//
// `0003_strategy_rules.sql` mirrors this, and a test cross-checks the two so
// they cannot drift — the whole point of the table is that it is the source
// of truth, which fails the moment the tests prove one thing and the database
// holds another.
// ---------------------------------------------------------------------------

export const DEFAULT_STRATEGY_RULES: StrategyRule[] = [
  { name: 'hard_suppress', priority: 100, strategy: 'suppress', cooldown_days: 0, enabled: true,
    match: { state_in: ['do_not_contact', 'handed_off'] } },
  { name: 'snoozed', priority: 95, strategy: 'suppress', cooldown_days: 0, enabled: true,
    match: { snoozed: true } },
  { name: 'touch_cap', priority: 90, strategy: 'suppress', cooldown_days: 0, enabled: true,
    match: { touch_count: { gte: { agent: 'max_touches' } } } },
  { name: 'warm_human_handles', priority: 80, strategy: 'suppress', cooldown_days: 0, enabled: true,
    match: { state_in: ['warm'], touch_count: { gt: 0 } } },
  { name: 'new_ad_lead', priority: 75, strategy: 'instant_qualify', cooldown_days: 0, enabled: true,
    match: { state_in: ['new'], source_eq: 'meta_ad' } },
  { name: 'last_chance', priority: 70, strategy: 'final_nudge', cooldown_days: 7, enabled: true,
    match: { state_in: ['cold', 'dormant'], touch_count: { eq: { agent: 'max_touches', offset: -1 } } } },
  { name: 'gap_fill', priority: 60, strategy: 'fill_missing_fact', cooldown_days: 5, enabled: true,
    match: { state_in: ['cold', 'dormant'], fact_gaps_len: { gt: 0 } } },
  { name: 'listing_hook', priority: 50, strategy: 'new_listing_hook', cooldown_days: 5, enabled: true,
    match: { state_in: ['cold'], days_silent: { gte: 14 }, fact_gaps_len: { eq: 0 } } },
  { name: 'gentle_check_in', priority: 40, strategy: 'soft_check_in', cooldown_days: 5, enabled: true,
    match: { state_in: ['cold'], touch_count: { lte: 2 } } },
  { name: 'long_dormant', priority: 30, strategy: 'market_update', cooldown_days: 14, enabled: true,
    match: { state_in: ['dormant'] } },
]
```

### Verify

```bash
cd $REPO
grep -c "name: '" packages/core/src/selectStrategy.ts      # 10 — the seeded rows
grep -c "cooldown_active" packages/core/src/selectStrategy.ts   # 2 — trap 1: appears as
                                                                # a trace value, never as a row
```

Expected: `10`, `2`.

---

## Step 3 — `supabase/migrations/0003_strategy_rules.sql`

The ten rows as reference data. This belongs in a **migration**, not `seed.ts` (task 8): `strategy_rules` is global, not tenant-scoped, and the app cannot function without it — `supabase db reset` must produce a working rules table. Task 8's seed is demo *fixtures* (agents, leads, messages), which is a different thing.

**Numbering note:** `CLAUDE.md` amendment A1 reserved `0003` for `approve_draft`. Task 5 lands before task 7, so `strategy_rules` takes `0003` and **`approve_draft` becomes `0004_approve_draft.sql`**. Update A1 in `CLAUDE.md` when you commit, so the next person doesn't collide.

Create the file with exactly this content:

```sql
-- Task 5 / planning-overview.md §6.3 — the 10 strategy rules.
--
-- Reference data, not demo fixtures: the cadence engine cannot run without
-- these, so they ship as a migration rather than in seed.ts (task 8).
--
-- There are 10 rows. `cooldown_active` is deliberately NOT among them — it is
-- a post-selection check in selectStrategy(), not a rule that competes on
-- priority. An earlier draft had it here at priority 85 matching
-- `days_since_outbound < 0`, which is always false and circular besides.
--
-- `match` is evaluated by selectStrategy() against a closed six-key schema:
-- state_in, source_eq, snoozed, touch_count, fact_gaps_len, days_silent.
-- Keys are ANDed; an unrecognised key throws. Numeric conditions take
-- eq/gt/gte/lt/lte, with either a literal or {"agent":"max_touches"} plus an
-- optional integer "offset" on the right-hand side.
--
-- Priorities must stay unique — selectStrategy() throws on a tie.

insert into strategy_rules (name, priority, strategy, cooldown_days, enabled, match) values
  ('hard_suppress',      100, 'suppress',          0, true,
   '{"state_in":["do_not_contact","handed_off"]}'::jsonb),

  ('snoozed',             95, 'suppress',          0, true,
   '{"snoozed":true}'::jsonb),

  ('touch_cap',           90, 'suppress',          0, true,
   '{"touch_count":{"gte":{"agent":"max_touches"}}}'::jsonb),

  ('warm_human_handles',  80, 'suppress',          0, true,
   '{"state_in":["warm"],"touch_count":{"gt":0}}'::jsonb),

  ('new_ad_lead',         75, 'instant_qualify',   0, true,
   '{"state_in":["new"],"source_eq":"meta_ad"}'::jsonb),

  ('last_chance',         70, 'final_nudge',       7, true,
   '{"state_in":["cold","dormant"],"touch_count":{"eq":{"agent":"max_touches","offset":-1}}}'::jsonb),

  ('gap_fill',            60, 'fill_missing_fact', 5, true,
   '{"state_in":["cold","dormant"],"fact_gaps_len":{"gt":0}}'::jsonb),

  ('listing_hook',        50, 'new_listing_hook',  5, true,
   '{"state_in":["cold"],"days_silent":{"gte":14},"fact_gaps_len":{"eq":0}}'::jsonb),

  ('gentle_check_in',     40, 'soft_check_in',     5, true,
   '{"state_in":["cold"],"touch_count":{"lte":2}}'::jsonb),

  ('long_dormant',        30, 'market_update',    14, true,
   '{"state_in":["dormant"]}'::jsonb);
```

### Verify

```bash
cd $REPO
supabase db reset
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select priority, name, strategy, cooldown_days from strategy_rules order by priority desc;"
```

10 rows, priorities descending 100 → 30, no `cooldown_active`.

```bash
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select count(*) as rules, count(distinct priority) as distinct_priorities from strategy_rules;"
```

Both columns `10` — the uniqueness §6.3 requires.

---

## Step 4 — `packages/core/src/selectStrategy.test.ts`

§11 asks for three things: every row fires when expected and loses when outranked; the cooldown check tested separately; and the Meta ad case. Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRow, LeadRow } from './types'
import { DEFAULT_STRATEGY_RULES, selectStrategy } from './selectStrategy'
import type { StrategyRule } from './selectStrategy'

const NOW = new Date('2026-07-30T10:00:00+08:00')

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString()
}

function daysAfter(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString()
}

const AGENT: AgentRow = {
  id: 'agent-id',
  name: 'Wei Ling',
  voice_profile: {
    formality: 2, warmth: 4, brevity: 4,
    sample_messages: [], sign_off: '', emoji_ok: false,
  },
  quiet_hours_start: 9,
  quiet_hours_end: 20,
  max_touches: 4,
  created_at: daysBefore(365),
}

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-id',
    agent_id: 'agent-id',
    name: 'Marcus',
    phone: '+6580000000',
    source: 'propertyguru',
    state: 'new',
    qualification_status: 'unqualified',
    last_inbound_at: null,
    last_outbound_at: null,
    touch_count: 0,
    snooze_until: null,
    opted_out: false,
    created_at: daysBefore(0),
    ...overrides,
  }
}

/**
 * State builders. classify() derives state from timestamps, so these produce
 * leads that genuinely land in the state their name claims — verified by the
 * `state` field every assertion below also checks.
 */
const newLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: null, touch_count: 0, created_at: daysBefore(1), ...o })

const warmLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(2), created_at: daysBefore(60), ...o })

/** cold, and silent for 20 days — long enough for listing_hook's `>= 14`. */
const coldSilentLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(20), created_at: daysBefore(60), ...o })

/** cold, but only 10 days silent — below listing_hook's threshold. */
const coldRecentLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(10), created_at: daysBefore(60), ...o })

const dormantLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(90), created_at: daysBefore(120), ...o })

function run(l: LeadRow, factGaps: string[] = [], rules: StrategyRule[] = DEFAULT_STRATEGY_RULES) {
  return selectStrategy({ lead: l, agent: AGENT, rules, factGaps, now: NOW })
}

const ALL_GAPS = ['transaction_type', 'budget_max', 'districts', 'timeline']

describe('selectStrategy — every rule fires when expected', () => {
  it('hard_suppress (100) on an opted-out lead', () => {
    const r = run(coldSilentLead({ opted_out: true }), ALL_GAPS)
    expect(r.state).toBe('do_not_contact')
    expect(r.rule_fired).toBe('hard_suppress')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBe(100)
  })

  it('hard_suppress (100) on a handed-off lead', () => {
    const r = run(coldSilentLead({ qualification_status: 'handed_off' }), ALL_GAPS)
    expect(r.rule_fired).toBe('hard_suppress')
  })

  it('snoozed (95) while snooze_until is in the future', () => {
    const r = run(coldSilentLead({ snooze_until: daysAfter(20) }), ALL_GAPS)
    expect(r.rule_fired).toBe('snoozed')
    expect(r.strategy).toBe('suppress')
  })

  it('touch_cap (90) at the agent max', () => {
    const r = run(coldSilentLead({ touch_count: 4 }), ALL_GAPS)
    expect(r.rule_fired).toBe('touch_cap')
  })

  it('warm_human_handles (80) once the AI has messaged and the lead replied', () => {
    const r = run(warmLead({ touch_count: 1 }))
    expect(r.state).toBe('warm')
    expect(r.rule_fired).toBe('warm_human_handles')
    expect(r.strategy).toBe('suppress')
  })

  it('new_ad_lead (75) on an untouched meta_ad lead', () => {
    const r = run(newLead({ source: 'meta_ad' }))
    expect(r.state).toBe('new')
    expect(r.rule_fired).toBe('new_ad_lead')
    expect(r.strategy).toBe('instant_qualify')
  })

  it('last_chance (70) at max_touches - 1', () => {
    const r = run(coldSilentLead({ touch_count: 3 }), ALL_GAPS)
    expect(r.rule_fired).toBe('last_chance')
    expect(r.strategy).toBe('final_nudge')
  })

  it('gap_fill (60) when facts are missing', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
    expect(r.strategy).toBe('fill_missing_fact')
  })

  it('listing_hook (50) when facts are complete and silence >= 14 days', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), [])
    expect(r.rule_fired).toBe('listing_hook')
    expect(r.strategy).toBe('new_listing_hook')
  })

  it('gentle_check_in (40) when cold, complete, and silent under 14 days', () => {
    const r = run(coldRecentLead({ touch_count: 1 }), [])
    expect(r.state).toBe('cold')
    expect(r.rule_fired).toBe('gentle_check_in')
    expect(r.strategy).toBe('soft_check_in')
  })

  it('long_dormant (30) on a dormant lead', () => {
    const r = run(dormantLead({ touch_count: 1 }), [])
    expect(r.state).toBe('dormant')
    expect(r.rule_fired).toBe('long_dormant')
    expect(r.strategy).toBe('market_update')
  })
})

describe('selectStrategy — lower-priority rules lose when outranked', () => {
  it('hard_suppress beats snoozed', () => {
    expect(run(coldSilentLead({ opted_out: true, snooze_until: daysAfter(20) }), ALL_GAPS)
      .rule_fired).toBe('hard_suppress')
  })

  it('snoozed beats touch_cap', () => {
    expect(run(coldSilentLead({ snooze_until: daysAfter(20), touch_count: 4 }), ALL_GAPS)
      .rule_fired).toBe('snoozed')
  })

  it('touch_cap beats last_chance', () => {
    // touch_count 4 satisfies `>= max_touches`; only 3 would be last_chance.
    expect(run(coldSilentLead({ touch_count: 4 }), ALL_GAPS).rule_fired).toBe('touch_cap')
  })

  it('last_chance beats gap_fill', () => {
    expect(run(coldSilentLead({ touch_count: 3 }), ALL_GAPS).rule_fired).toBe('last_chance')
  })

  it('gap_fill beats listing_hook', () => {
    // 20 days silent would satisfy listing_hook, but gaps exist.
    expect(run(coldSilentLead({ touch_count: 1 }), ['timeline']).rule_fired).toBe('gap_fill')
  })

  it('gap_fill beats gentle_check_in', () => {
    expect(run(coldRecentLead({ touch_count: 1 }), ['timeline']).rule_fired).toBe('gap_fill')
  })

  it('listing_hook beats gentle_check_in', () => {
    expect(run(coldSilentLead({ touch_count: 1 }), []).rule_fired).toBe('listing_hook')
  })

  it('records every enabled rule in rules_evaluated, winner included', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), ['timeline'])
    expect(r.rules_evaluated).toHaveLength(10)
    expect(r.rules_evaluated.find((e) => e.name === 'gap_fill')?.matched).toBe(true)
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('skips disabled rules entirely', () => {
    const withoutGapFill = DEFAULT_STRATEGY_RULES.map((r) =>
      r.name === 'gap_fill' ? { ...r, enabled: false } : r,
    )
    const r = run(coldRecentLead({ touch_count: 1 }), ['timeline'], withoutGapFill)
    expect(r.rule_fired).toBe('gentle_check_in')
    expect(r.rules_evaluated).toHaveLength(9)
  })
})

describe('selectStrategy — the Meta ad lead (§11)', () => {
  it('a zero-touch new + meta_ad lead reaches instant_qualify', () => {
    const r = run(newLead({ source: 'meta_ad' }))
    expect(r.rule_fired).toBe('new_ad_lead')
    expect(r.strategy).toBe('instant_qualify')
    // warm_human_handles must not have swallowed it.
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('warm_human_handles stands down for a zero-touch lead that just replied', () => {
    const r = run(warmLead({ source: 'meta_ad', touch_count: 0 }))
    expect(r.state).toBe('warm')
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('DOCUMENTED GAP: a meta_ad lead who submitted the form matches no rule', () => {
    // Submitting the ad form IS an inbound message, so classify() returns
    // `warm`, not `new`. warm_human_handles correctly stands down
    // (touch_count is 0), but new_ad_lead requires state == 'new' — so
    // nothing matches and the lead gets no first contact.
    //
    // This pins the CURRENT behaviour of §6.3 as literally specified. It is
    // not an endorsement: it is a question for the founder (see README).
    // Do not "fix" the rule table to make this test go green — contract
    // rule 1 forbids inventing business logic.
    const r = run(lead({
      source: 'meta_ad',
      touch_count: 0,
      last_inbound_at: daysBefore(0),
      created_at: daysBefore(0),
    }))
    expect(r.state).toBe('warm')
    expect(r.rule_fired).toBe('no_rule_matched')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBeNull()
  })
})

describe('selectStrategy — post-selection cooldown (trap 2)', () => {
  it('suppresses when the winner is inside its cooldown, naming the blocked rule', () => {
    // gap_fill has cooldown_days 5; last outbound was 2 days ago.
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(2) }), ['timeline'])
    expect(r.rule_fired).toBe('cooldown_active')
    expect(r.strategy).toBe('suppress')
    expect(r.suppressed_by_cooldown).toBe('gap_fill')
    expect(r.rule_priority).toBeNull()
  })

  it('allows the rule once the cooldown has elapsed', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(6) }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
    expect(r.suppressed_by_cooldown).toBeUndefined()
  })

  it('treats the cooldown boundary as inclusive (days == cooldown_days fires)', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(5) }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
  })

  it('never cools down a lead that has never been messaged', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: null }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
  })

  it('does not cooldown-suppress a zero-cooldown suppression rule', () => {
    // hard_suppress has cooldown_days 0, so `days < 0` is never true.
    const r = run(coldSilentLead({ opted_out: true, last_outbound_at: daysBefore(0) }), ALL_GAPS)
    expect(r.rule_fired).toBe('hard_suppress')
  })
})

describe('selectStrategy — no rule matches', () => {
  it('returns suppress with no_rule_matched and a null priority', () => {
    // A `new` non-ad lead: §6.1's documented two-day cold start.
    const r = run(newLead({ source: 'propertyguru' }))
    expect(r.state).toBe('new')
    expect(r.rule_fired).toBe('no_rule_matched')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBeNull()
  })
})

describe('selectStrategy — malformed rules fail loudly (trap 5)', () => {
  it('throws on an unknown match key rather than matching everything', () => {
    const typo = [{ ...DEFAULT_STRATEGY_RULES[0]!, match: { state_id: ['cold'] } }]
    expect(() => run(coldSilentLead(), [], typo)).toThrow(/unknown key "state_id"/)
  })

  it('throws on an unknown numeric operator', () => {
    const bad = [{ ...DEFAULT_STRATEGY_RULES[0]!, match: { touch_count: { above: 2 } } }]
    expect(() => run(coldSilentLead(), [], bad)).toThrow(/unknown operator "above"/)
  })

  it('throws when two enabled rules share a priority', () => {
    const tied = [
      { ...DEFAULT_STRATEGY_RULES[0]! },
      { ...DEFAULT_STRATEGY_RULES[1]!, priority: 100 },
    ]
    expect(() => run(coldSilentLead(), [], tied)).toThrow(/priority 100 is used by both/)
  })
})

describe('the migration and DEFAULT_STRATEGY_RULES cannot drift', () => {
  it('0003_strategy_rules.sql seeds exactly the canonical rules', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '0003_strategy_rules.sql'),
      'utf8',
    )

    // One `('<name>', <priority>, '<strategy>', <cooldown>, <enabled>,` per row.
    const rows = [...sql.matchAll(
      /\('(\w+)',\s*(\d+),\s*'([\w_]+)',\s*(\d+),\s*(true|false),/g,
    )].map((m) => ({
      name: m[1], priority: Number(m[2]), strategy: m[3],
      cooldown_days: Number(m[4]), enabled: m[5] === 'true',
    }))

    expect(rows).toHaveLength(DEFAULT_STRATEGY_RULES.length)
    for (const expected of DEFAULT_STRATEGY_RULES) {
      expect(rows).toContainEqual({
        name: expected.name,
        priority: expected.priority,
        strategy: expected.strategy,
        cooldown_days: expected.cooldown_days,
        enabled: expected.enabled,
      })
    }
  })

  it('does not seed cooldown_active as a row (trap 1)', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '0003_strategy_rules.sql'),
      'utf8',
    )
    expect(sql).not.toMatch(/\('cooldown_active'/)
    expect(sql).not.toMatch(/\('no_rule_matched'/)
  })
})
```

Note what the last block buys you: the SQL migration and the TypeScript constant are two copies of the same ten rules, and nothing else would stop them diverging. A drift means the tests prove one rule set correct while the running app loads another — the failure mode most likely to survive all the way to a live demo.

---

## Step 5 — Add `selectStrategy` to the barrel

In `$REPO/packages/core/src/index.ts`, add one line:

```ts
export * from './types'
export * from './sg-rules'
export * from './facts'
export * from './classify'
export * from './selectStrategy'
```

---

## Step 6 — Full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0. `pnpm test` should report **4 test files** (`classify`, `facts`, `leads-state-writer`, `selectStrategy`) and **59 tests** — 21 + 3 + 1 + 34. Treat the count as informational.

**Do not try to exercise `selectStrategy` with a `node --input-type=module` one-liner** the way tasks 3 and 4 did. Those worked because their leaf files had no runtime imports (`facts.ts` and `classify.ts` import only `import type`, which is erased). `selectStrategy.ts` genuinely imports `./classify` at runtime, and Node's ESM loader will not resolve an extensionless specifier — you get `ERR_MODULE_NOT_FOUND` on `./classify`. That is a Node limitation, not a defect: `moduleResolution: "bundler"` is exactly what lets TypeScript, Vite, Vitest and Deno accept those specifiers. Vitest already runs this code; trust the suite.

Instead, close the loop the test suite *can't* — the drift test reads the migration as **text**, so it proves the SQL file agrees with `DEFAULT_STRATEGY_RULES`, but not that the applied database does. Query the real thing:

```bash
cd $REPO
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select priority, name, strategy, cooldown_days from strategy_rules order by priority desc;"
```

Expected, exactly 10 rows:

```
 priority |        name        |     strategy      | cooldown_days
----------+--------------------+-------------------+---------------
      100 | hard_suppress      | suppress          |             0
       95 | snoozed            | suppress          |             0
       90 | touch_cap          | suppress          |             0
       80 | warm_human_handles | suppress          |             0
       75 | new_ad_lead        | instant_qualify   |             0
       70 | last_chance        | final_nudge       |             7
       60 | gap_fill           | fill_missing_fact |             5
       50 | listing_hook       | new_listing_hook  |             5
       40 | gentle_check_in    | soft_check_in     |             5
       30 | long_dormant       | market_update     |            14
(10 rows)
```

If that prints `(0 rows)`, the migration didn't apply — check `supabase migration list --local` shows `0003`.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `Type '"cooldown_active"' is not assignable to type 'SeededRuleName'` | Trap 1 — you tried to seed it as a row | Delete the row; it is a post-selection outcome |
| Every lead returns `hard_suppress` | An unknown `match` key made rule 100 vacuously match | Trap 5 — the thrown error names the key; fix the JSON |
| `gap_fill` fires where you expected `listing_hook` | Non-empty `factGaps` — `gap_fill` (60) outranks `listing_hook` (50) | Pass `[]` for the complete-facts case |
| `listing_hook` fires where you expected `gentle_check_in` | The lead is ≥14 days silent | Use a lead 8–13 days silent — still `cold`, below the threshold |
| A "cold" fixture classifies as `warm` | `last_inbound_at` within 7 days | `cold` needs 8–45 days since the last inbound |
| The drift test can't find the migration | Wrong relative path from `packages/core/src` | `join(dirname(fileURLToPath(import.meta.url)), '..','..','..')` |
| `strategy_rules` empty after `supabase db reset` | Migration not applied, or `db.seed.enabled` confusion | The rows are in a **migration**, not `seed.sql`; check `supabase migration list --local` |

---

## Step 7 — Acceptance and commit

### Checklist

- [ ] 10 rows in both `DEFAULT_STRATEGY_RULES` and `0003_strategy_rules.sql`; no `cooldown_active` row
- [ ] The drift test passes, proving the two copies agree
- [ ] Cooldown is applied **after** a winner is chosen, and reports `suppressed_by_cooldown`
- [ ] `rule_priority` is `null` for `cooldown_active` and `no_rule_matched`
- [ ] Unknown match key, unknown operator, and duplicate priority all **throw**
- [ ] Every one of the 10 rules has a fires-when-expected test and at least one loses-when-outranked test
- [ ] The documented Meta-ad gap is pinned by a test and written up for the README, not silently fixed
- [ ] `selectStrategy()` calls `classify()` itself and reads no `Date.now()`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all exit 0
- [ ] `CLAUDE.md` amendment A1 updated: `approve_draft` is now `0004`, not `0003`
- [ ] No guardrail, no `MockProvider`, no `generate-drafts` — tasks 6, 7, 11

### Expected tree

```
$REPO/
├── CLAUDE.md                                   # edited: A1 renumber, current state
├── packages/core/src/
│   ├── selectStrategy.ts                       # new
│   ├── selectStrategy.test.ts                  # new
│   └── index.ts                                # edited: +./selectStrategy
└── supabase/migrations/
    └── 0003_strategy_rules.sql                 # new
```

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 5: selectStrategy + strategy_rules seed"
```

---

## Next

Task 6 — `guardrail.ts`, G1–G5, with G3's five normalizer tests written **first**. G3 is the check the repo's whole anti-hallucination story rests on: every number ≥ 1000, `$`-amount, `DXX`, and date-like token in a draft must trace back to the fact set.

Three things to know:

- **There are five guardrails, not seven.** Quiet hours moved to `approve_draft` (§8) because it is a send-time policy, not a draft-time one; no-double-send was deleted as a duplicate of the cooldown check you just built. Renumbering: G4 is "no advice", G5 is "placeholder leak".
- **G3's normalizer is specified literally in §6.4** — five numbered steps including the `k`/`m`/`mil`/`million` suffix multiplication that must run *before* the ≥1000 filter, a word-number map so "one point two million" is caught, and a 2020–2035 year whitelist so `market_update` drafts mentioning the current year don't false-positive.
- **Tone check is not in `guardrail.ts`.** It is an LLM call made by `generate-drafts` at task 11, after G1–G5 pass.
