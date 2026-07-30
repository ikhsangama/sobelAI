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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function resolveOperand(operand: NumOperand, ctx: EvalContext): number {
  if (typeof operand === 'number') return operand
  return ctx.max_touches + (operand.offset ?? 0)
}

/**
 * Validates a single operand: a number literal, or a reference to the
 * agent's touch cap. `agent` only ever means `'max_touches'` today, so any
 * other value (a typo, or a reference to a field this schema doesn't
 * expose) is rejected here rather than silently falling through to
 * `max_touches` anyway — see review finding 2 on PR #11.
 */
function parseNumOperand(raw: unknown, rule: SeededRuleName, field: string, op: string): NumOperand {
  if (typeof raw === 'number') return raw
  if (isPlainObject(raw) && raw.agent === 'max_touches') {
    if ('offset' in raw && typeof raw.offset !== 'number') {
      throw new Error(
        `strategy_rules.match: ${field}.${op}.offset on rule "${rule}" must be a number, ` +
          `got ${JSON.stringify(raw.offset)}.`,
      )
    }
    return raw as NumOperand
  }
  throw new Error(
    `strategy_rules.match: ${field}.${op} on rule "${rule}" must be a number or ` +
      `{"agent":"max_touches"}, got ${JSON.stringify(raw)}.`,
  )
}

/**
 * Validates and parses a numeric condition. Must be a non-empty object of
 * recognised operators — this is where PR #11 review finding 2 lived:
 * `{ touch_count: 5 }` (a bare number instead of `{ eq: 5 }`), `{}` (empty),
 * and `{ gte: "5" }` (a string operand) all previously passed straight
 * through to `compareNum`, which silently treated each as "match anything"
 * rather than failing loudly the way an unknown top-level key already did.
 */
function parseNumCondition(raw: unknown, rule: SeededRuleName, field: string): NumCondition {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new Error(
      `strategy_rules.match: ${field} on rule "${rule}" must be a non-empty object of ` +
        `operators (${NUM_OPS.join(', ')}), got ${JSON.stringify(raw)}.`,
    )
  }
  const parsed: NumCondition = {}
  for (const [op, operand] of Object.entries(raw)) {
    if (!(NUM_OPS as readonly string[]).includes(op)) {
      throw new Error(
        `strategy_rules.match: unknown operator "${op}" on ${field} of rule ` +
          `"${rule}". Allowed: ${NUM_OPS.join(', ')}.`,
      )
    }
    parsed[op as keyof NumCondition] = parseNumOperand(operand, rule, field, op)
  }
  return parsed
}

function compareNum(
  actual: number,
  condition: NumCondition,
  ctx: EvalContext,
): boolean {
  for (const [op, operand] of Object.entries(condition)) {
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

/**
 * Trap 5: an unrecognised key would make a rule vacuously match everything.
 * Validates every recognised key's *value* too, not just the key names —
 * see the SPEC-GAP note above `RuleMatch` and PR #11 review finding 2 for
 * why a value-shape check matters just as much as a key-name check here.
 */
function parseMatch(raw: Record<string, unknown>, rule: SeededRuleName): RuleMatch {
  for (const key of Object.keys(raw)) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `strategy_rules.match: unknown key "${key}" on rule "${rule}". ` +
          `Allowed: ${MATCH_KEYS.join(', ')}.`,
      )
    }
  }

  const parsed: RuleMatch = {}

  if ('state_in' in raw) {
    if (!Array.isArray(raw.state_in)) {
      throw new Error(
        `strategy_rules.match: state_in on rule "${rule}" must be an array, ` +
          `got ${JSON.stringify(raw.state_in)}.`,
      )
    }
    parsed.state_in = raw.state_in as LeadState[]
  }
  if ('source_eq' in raw) {
    if (typeof raw.source_eq !== 'string') {
      throw new Error(
        `strategy_rules.match: source_eq on rule "${rule}" must be a string, ` +
          `got ${JSON.stringify(raw.source_eq)}.`,
      )
    }
    parsed.source_eq = raw.source_eq as LeadSource
  }
  if ('snoozed' in raw) {
    if (typeof raw.snoozed !== 'boolean') {
      throw new Error(
        `strategy_rules.match: snoozed on rule "${rule}" must be a boolean, ` +
          `got ${JSON.stringify(raw.snoozed)}.`,
      )
    }
    parsed.snoozed = raw.snoozed
  }
  if ('touch_count' in raw) parsed.touch_count = parseNumCondition(raw.touch_count, rule, 'touch_count')
  if ('fact_gaps_len' in raw)
    parsed.fact_gaps_len = parseNumCondition(raw.fact_gaps_len, rule, 'fact_gaps_len')
  if ('days_silent' in raw) parsed.days_silent = parseNumCondition(raw.days_silent, rule, 'days_silent')

  return parsed
}

function matches(m: RuleMatch, ctx: EvalContext): boolean {
  if (m.state_in && !m.state_in.includes(ctx.state)) return false
  if (m.source_eq !== undefined && ctx.source !== m.source_eq) return false
  if (m.snoozed !== undefined && ctx.snoozed !== m.snoozed) return false
  if (m.touch_count && !compareNum(ctx.touch_count, m.touch_count, ctx)) return false
  if (m.fact_gaps_len && !compareNum(ctx.fact_gaps_len, m.fact_gaps_len, ctx)) return false
  if (m.days_silent && !compareNum(ctx.days_silent, m.days_silent, ctx)) return false
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
    const matched = matches(parseMatch(rule.match, rule.name), ctx)
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
