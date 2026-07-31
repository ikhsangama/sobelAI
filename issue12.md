# Task 12 — the eval harness

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 12:

> `packages/eval`: runner + assertions + the 12 fixtures from §10, starting with F01, F02, F03, F05, F18, F19. Get green. This includes the two-voice comparison fixture from task 8, printed side by side in `--verbose` output.

**Outcome:** the thing that proves the pipeline works. §11 calls this and task 16 *"the two deliverables that can't be faked in a live demo"*, and puts **"Never skip 12 (eval)"** in the triage note. It replays fixtures through `extract-facts` and `generate-drafts` with a pinned `now`, asserts on the trace shape task 11 produces, and writes `eval_runs`.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `write-v2` / the planted regression | Task 16 |
| `/queue` UI, approve/skip | Task 13 |
| `TracePanel` | Task 15 |
| `0005_approve_draft.sql` | Still outstanding; A1 allows it any time before task 13 |

Everything you need to type is written out in full below.

---

## Read this before you start

### Eight traps

**Trap 1 — `pnpm eval` wipes the database. Re-seed afterwards.**
§10 says each fixture starts by truncating `leads, messages, lead_facts, drafts`. Verified: deleting all `agents` rows cascades to every one of those (`0001_init.sql` declares `on delete cascade` the whole way down), so PostgREST can do it without an RPC. The consequence is that a full `pnpm eval` run **destroys task 8's seeded demo data**. Always finish with:

```bash
pnpm seed
```

Do not run `pnpm eval` five minutes before a live demo without re-seeding after.

**Trap 2 — `packages/eval/tsconfig.json` needs `allowImportingTsExtensions`, and the failure is typecheck-only.**
`packages/core` uses `.ts` extensions on every relative import (amendment A6). The moment `run.ts` imports `@revive/core`, `pnpm typecheck` fails with `TS5097` — but **`tsx` runs the file fine**, so `pnpm eval` will appear to work while the repo's typecheck is broken. Measured both ways. `packages/llm` needed exactly this at task 9; do it in Step 1 before anything else.

**Trap 3 — the `pipeline_error` hard-fail is the reason F18 and F19 mean anything.**
§10 puts this *before* every other assertion: if a fixture expects facts but `extract-facts` returns non-200, or returns `inserted == 0 && rejected == 0`, the fixture fails immediately. `facts_absent` and `no_hallucinated_entities` are pure negatives — **a completely dead extraction path satisfies both** — and F18/F19 are the two fixtures §10 calls "the two that matter most". A green `pnpm eval` on a broken pipeline is the single most embarrassing demo failure available, so it's checked structurally rather than trusted to fixture authors.

Note `rejected > 0` counts as "the pipeline ran". Facts being rejected is the evidence rule working, not the pipeline being dead.

**Trap 4 — `tone_acceptable` is soft and must not move the exit code.**
§10: label it `[soft]` in output and exclude it from exit-code failure unless `--strict`. It's the one non-deterministic assertion; letting it fail CI turns a flaky model mood into a red build.

**Trap 5 — the `now` override needs the service-role key in an `Authorization` header.**
§8 rejects a client-supplied `now` with 400 unless `dry_run: true` or the caller presents the service-role key. The eval harness needs a real `now` *and* real persistence, so it must send `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. Verified working against the running edge runtime.

**Trap 6 — read `state` from the stored column, not from the trace.**
§6.1: *"Any fixture assertion on `state` (e.g. F05) reads the **stored column after a `generate-drafts` run**, not `trace.state` in isolation."* They're guaranteed identical only after that write happens, and asserting on the column is what proves the write happened at all.

**Trap 7 — this costs real money and real time.**
12 fixtures × (1 extract + 1 write + 1 tone) ≈ 36 LLM calls per full run, plus the two-voice fixture's extra draft. Use `--only F01_cold_buyer_21d` while developing. §11's priority order if you're short: **F01, F02, F03, F05, F18, F19**.

**Trap 8 — the prompts are frozen.**
§11's checkpoint fired at task 11. If a fixture goes red because a prompt is imperfect, **fix the fixture or the code, not the prompt** — task 16's planted regression needs `write-v1` to be the same text the baseline was built on. If a prompt genuinely must change, that's a conversation, not a quiet edit.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Local Supabase running, migrations applied, and `ANTHROPIC_API_KEY` set in `.env.local`.

---

## Step 1 — `packages/eval/tsconfig.json`

Trap 2. Add one line under `"moduleResolution"`:

```json
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
```

### Verify

```bash
cd $REPO && pnpm typecheck
```

Exits 0 (it already did — this is pre-emptive, and Step 2 is what would otherwise break it).

---

## Step 2 — `packages/eval/src/assertions.ts`

§10's eight assertion types as pure functions. Create the file with exactly this content:

```ts
import type { Fact } from '@revive/core'
import { guardrail } from '@revive/core'

/**
 * §10's eight assertion types, as pure functions over what the pipeline
 * produced. No I/O — `run.ts` does the database and HTTP work and hands the
 * results here, the same split contract rule 3 applies to `classify()` and
 * `selectStrategy()`.
 */

export interface ExpectedFact {
  key: string
  value: unknown
}

/** §10 assertion 2: a bare key, or a key plus a value it must NOT contain. */
export type AbsentSpec = string | { key: string; value_not: unknown }

export interface FixtureExpect {
  facts_extracted?: ExpectedFact[]
  facts_absent?: AbsentSpec[]
  state?: string
  rule_fired?: string
  strategy?: string
  no_draft?: boolean
  no_hallucinated_entities?: boolean
  draft_contains?: string[]
  draft_omits?: string[]
  tone_acceptable?: boolean
  snooze_until_set?: boolean
}

/** What `run.ts` observed after driving the pipeline for one fixture. */
export interface Observed {
  facts: Fact[]
  state: string | null
  rule_fired: string | null
  strategy: string | null
  outcome: string | null
  draftBody: string | null
  draftRowCount: number
  toneVerdict: 'pass' | 'fail' | null
  snoozeUntil: string | null
}

export interface Failure {
  assertion: string
  detail: string
  /** §10: tone is the non-deterministic one; excluded from exit code unless --strict. */
  soft?: boolean
}

/** Deep-equal for jsonb-ish values (§10 assertion 1: "Deep-equal on value"). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function live(facts: Fact[]): Fact[] {
  return facts.filter((f) => !f.superseded_at)
}

/** Substring containment that also looks inside arrays and numbers. */
function valueContains(value: unknown, needle: unknown): boolean {
  if (deepEqual(value, needle)) return true
  if (Array.isArray(value)) return value.some((v) => deepEqual(v, needle))
  return JSON.stringify(value ?? '').toLowerCase().includes(String(needle).toLowerCase())
}

/**
 * §10's runner-level hard fail. A fixture that expects facts but whose
 * extraction did nothing fails as `pipeline_error` before any other assertion
 * runs, because `facts_absent` and `no_hallucinated_entities` are pure
 * negatives that a dead pipeline satisfies trivially — and F18/F19, the two
 * §10 calls most important, lean on exactly those.
 */
export function pipelineError(
  expect: FixtureExpect,
  extract: { ok: boolean; inserted: number; rejected: number },
): Failure | null {
  if (!expect.facts_extracted || expect.facts_extracted.length === 0) return null
  if (!extract.ok) {
    return { assertion: 'pipeline_error', detail: 'extract-facts returned non-200' }
  }
  if (extract.inserted === 0 && extract.rejected === 0) {
    return {
      assertion: 'pipeline_error',
      detail: 'extract-facts inserted 0 and rejected 0 — the extraction path did nothing',
    }
  }
  return null
}

export function runAssertions(expect: FixtureExpect, observed: Observed): Failure[] {
  const failures: Failure[] = []
  const facts = live(observed.facts)

  // 1 — facts_extracted
  for (const want of expect.facts_extracted ?? []) {
    const hit = facts.find((f) => f.key === want.key && deepEqual(f.value, want.value))
    if (!hit) {
      const got = facts.filter((f) => f.key === want.key).map((f) => f.value)
      failures.push({
        assertion: 'facts_extracted',
        detail: `${want.key} expected ${JSON.stringify(want.value)}, got ${
          got.length ? JSON.stringify(got) : '(no fact with that key)'
        }`,
      })
    }
  }

  // 2 — facts_absent
  for (const spec of expect.facts_absent ?? []) {
    const key = typeof spec === 'string' ? spec : spec.key
    const matching = facts.filter((f) => f.key === key)
    if (typeof spec === 'string') {
      if (matching.length > 0) {
        failures.push({
          assertion: 'facts_absent',
          detail: `${key} should not exist, got ${JSON.stringify(matching.map((f) => f.value))}`,
        })
      }
    } else {
      const offending = matching.filter((f) => valueContains(f.value, spec.value_not))
      if (offending.length > 0) {
        failures.push({
          assertion: 'facts_absent',
          detail: `${key} must not contain ${JSON.stringify(spec.value_not)}, got ${JSON.stringify(
            offending.map((f) => f.value),
          )}`,
        })
      }
    }
  }

  // state — §6.1 says read the stored column, which run.ts supplies (trap 6)
  if (expect.state !== undefined && observed.state !== expect.state) {
    failures.push({ assertion: 'state', detail: `expected ${expect.state}, got ${observed.state}` })
  }

  // 3 — strategy_selected
  if (expect.strategy !== undefined && observed.strategy !== expect.strategy) {
    failures.push({
      assertion: 'strategy_selected',
      detail: `expected ${expect.strategy}, got ${observed.strategy}`,
    })
  }

  // 4 — rule_fired
  if (expect.rule_fired !== undefined && observed.rule_fired !== expect.rule_fired) {
    failures.push({
      assertion: 'rule_fired',
      detail: `expected ${expect.rule_fired}, got ${observed.rule_fired}`,
    })
  }

  // 5 — no_draft
  if (expect.no_draft) {
    if (observed.outcome !== 'suppressed') {
      failures.push({ assertion: 'no_draft', detail: `outcome was ${observed.outcome}` })
    }
    if (observed.draftRowCount !== 0) {
      failures.push({
        assertion: 'no_draft',
        detail: `${observed.draftRowCount} drafts row(s) were written`,
      })
    }
  }

  // 6 — no_hallucinated_entities: re-run G3 independently of the pipeline.
  if (expect.no_hallucinated_entities) {
    if (observed.draftBody === null) {
      failures.push({
        assertion: 'no_hallucinated_entities',
        detail: 'no draft body to check',
      })
    } else {
      const g = guardrail(observed.draftBody, facts)
      if (!g.pass && g.failedRule === 'G3') {
        failures.push({ assertion: 'no_hallucinated_entities', detail: g.detail ?? 'G3 failed' })
      }
    }
  }

  // 7 — draft_contains / draft_omits, case-insensitive substrings
  const lower = (observed.draftBody ?? '').toLowerCase()
  for (const needle of expect.draft_contains ?? []) {
    if (!lower.includes(needle.toLowerCase())) {
      failures.push({ assertion: 'draft_contains', detail: `draft does not contain "${needle}"` })
    }
  }
  for (const needle of expect.draft_omits ?? []) {
    if (lower.includes(needle.toLowerCase())) {
      failures.push({ assertion: 'draft_omits', detail: `draft contains "${needle}"` })
    }
  }

  if (expect.snooze_until_set && !observed.snoozeUntil) {
    failures.push({ assertion: 'snooze_until_set', detail: 'snooze_until is null' })
  }

  // 8 — tone_acceptable, marked soft (§10)
  if (expect.tone_acceptable && observed.toneVerdict !== null && observed.toneVerdict !== 'pass') {
    failures.push({
      assertion: 'tone_acceptable',
      detail: `tone verdict was ${observed.toneVerdict}`,
      soft: true,
    })
  }

  return failures
}

/** §10: soft failures never move the exit code unless `--strict`. */
export function isFailing(failures: Failure[], strict: boolean): boolean {
  return failures.some((f) => strict || !f.soft)
}
```

---

## Step 3 — `packages/eval/src/assertions.test.ts`

The assertions are the one part of this task that's deterministic and free to test. Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import { isFailing, pipelineError, runAssertions } from './assertions'
import type { Observed } from './assertions'
import type { Fact } from '@revive/core'

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'f1',
    lead_id: 'l1',
    agent_id: 'a1',
    key: 'transaction_type',
    value: 'buy',
    confidence: 0.9,
    source_message_id: 'm1',
    evidence: 'looking to buy',
    extracted_at: '2026-07-30T00:00:00Z',
    superseded_at: null,
    ...over,
  }
}

function observed(over: Partial<Observed> = {}): Observed {
  return {
    facts: [],
    state: 'cold',
    rule_fired: 'gap_fill',
    strategy: 'fill_missing_fact',
    outcome: 'drafted',
    draftBody: 'hey Marcus, quick one to help me shortlist better for you',
    draftRowCount: 1,
    toneVerdict: 'pass',
    snoozeUntil: null,
    ...over,
  }
}

describe('pipeline_error — §10s runner-level hard fail', () => {
  it('fires when a fixture expects facts but extraction did nothing', () => {
    const f = pipelineError(
      { facts_extracted: [{ key: 'transaction_type', value: 'buy' }] },
      { ok: true, inserted: 0, rejected: 0 },
    )
    expect(f?.assertion).toBe('pipeline_error')
  })

  it('fires when extract-facts returned non-200', () => {
    const f = pipelineError(
      { facts_extracted: [{ key: 'transaction_type', value: 'buy' }] },
      { ok: false, inserted: 0, rejected: 0 },
    )
    expect(f?.assertion).toBe('pipeline_error')
  })

  it('does not fire when facts were rejected — the pipeline still ran', () => {
    expect(
      pipelineError(
        { facts_extracted: [{ key: 'transaction_type', value: 'buy' }] },
        { ok: true, inserted: 0, rejected: 2 },
      ),
    ).toBeNull()
  })

  it('does not fire for a fixture that expects no facts (e.g. F05)', () => {
    expect(pipelineError({ no_draft: true }, { ok: true, inserted: 0, rejected: 0 })).toBeNull()
  })
})

describe('facts_extracted — deep-equal on value', () => {
  it('passes on an exact match, including array values', () => {
    const o = observed({ facts: [fact({ key: 'districts', value: ['D15'] })] })
    expect(runAssertions({ facts_extracted: [{ key: 'districts', value: ['D15'] }] }, o)).toEqual([])
  })

  it('fails when the value differs, and reports what was actually there', () => {
    const o = observed({ facts: [fact({ key: 'budget_max', value: 1200000 })] })
    const f = runAssertions({ facts_extracted: [{ key: 'budget_max', value: 1500000 }] }, o)
    expect(f).toHaveLength(1)
    expect(f[0]!.detail).toContain('1200000')
  })

  it('does not accept a superseded fact as a match (F14s whole point)', () => {
    const o = observed({
      facts: [
        fact({ key: 'budget_max', value: 900000, superseded_at: '2026-07-30T00:00:00Z' }),
        fact({ key: 'budget_max', value: 1200000 }),
      ],
    })
    expect(runAssertions({ facts_extracted: [{ key: 'budget_max', value: 1200000 }] }, o)).toEqual([])
    expect(runAssertions({ facts_extracted: [{ key: 'budget_max', value: 900000 }] }, o)).toHaveLength(1)
  })
})

describe('facts_absent — the anti-inference tests', () => {
  it('passes when the key is genuinely missing', () => {
    expect(runAssertions({ facts_absent: ['timeline'] }, observed())).toEqual([])
  })

  it('fails when the key exists', () => {
    const o = observed({ facts: [fact({ key: 'timeline', value: 'exploring' })] })
    expect(runAssertions({ facts_absent: ['timeline'] }, o)).toHaveLength(1)
  })

  it('supports value_not, so an unrelated district still passes (F18)', () => {
    // F18: "I stay in Tampines, looking to buy in the east" must not yield D18.
    const ok = observed({ facts: [fact({ key: 'districts', value: ['D15'] })] })
    expect(
      runAssertions({ facts_absent: [{ key: 'districts', value_not: 'D18' }] }, ok),
    ).toEqual([])

    const bad = observed({ facts: [fact({ key: 'districts', value: ['D18'] })] })
    expect(
      runAssertions({ facts_absent: [{ key: 'districts', value_not: 'D18' }] }, bad),
    ).toHaveLength(1)
  })
})

describe('rule / strategy / state / no_draft', () => {
  it('matches exact strings and reports both sides on mismatch', () => {
    const f = runAssertions(
      { rule_fired: 'listing_hook', strategy: 'new_listing_hook', state: 'cold' },
      observed(),
    )
    expect(f.map((x) => x.assertion).sort()).toEqual(['rule_fired', 'strategy_selected'])
  })

  it('no_draft requires both a suppressed outcome and zero draft rows', () => {
    expect(
      runAssertions({ no_draft: true }, observed({ outcome: 'suppressed', draftRowCount: 0 })),
    ).toEqual([])
    expect(
      runAssertions({ no_draft: true }, observed({ outcome: 'drafted', draftRowCount: 1 })),
    ).toHaveLength(2)
  })
})

describe('no_hallucinated_entities — re-runs G3 independently', () => {
  it('fails a draft naming a district that is not in the fact set', () => {
    const o = observed({
      facts: [fact({ key: 'districts', value: ['D15'] })],
      draftBody: 'hey! a 3 bedder just came up in D03, want me to send it over to you today?',
    })
    const f = runAssertions({ no_hallucinated_entities: true }, o)
    expect(f).toHaveLength(1)
    expect(f[0]!.detail).toContain('D03')
  })

  it('passes a draft that only names districts present in the facts', () => {
    const o = observed({
      facts: [fact({ key: 'districts', value: ['D15'] })],
      draftBody: 'hey! something just came up in D15 that matches what you described, keen to see?',
    })
    expect(runAssertions({ no_hallucinated_entities: true }, o)).toEqual([])
  })

  it('fails loudly when there is no draft rather than passing vacuously', () => {
    const f = runAssertions({ no_hallucinated_entities: true }, observed({ draftBody: null }))
    expect(f).toHaveLength(1)
  })
})

describe('draft_contains / draft_omits — case-insensitive', () => {
  it('omits catches a "$" figure the model invented (F20)', () => {
    const o = observed({ draftBody: 'that unit is going for about $1.2m, keen to view it?' })
    expect(runAssertions({ draft_omits: ['$'] }, o)).toHaveLength(1)
  })

  it('contains is case-insensitive', () => {
    const o = observed({ draftBody: 'Happy to help with the D15 search' })
    expect(runAssertions({ draft_contains: ['d15'] }, o)).toEqual([])
  })
})

describe('tone_acceptable is soft', () => {
  it('is reported but marked soft', () => {
    const f = runAssertions({ tone_acceptable: true }, observed({ toneVerdict: 'fail' }))
    expect(f).toHaveLength(1)
    expect(f[0]!.soft).toBe(true)
  })

  it('does not fail the run by default, but does under --strict', () => {
    const f = runAssertions({ tone_acceptable: true }, observed({ toneVerdict: 'fail' }))
    expect(isFailing(f, false)).toBe(false)
    expect(isFailing(f, true)).toBe(true)
  })

  it('a hard failure fails the run regardless of strict', () => {
    const f = runAssertions({ rule_fired: 'touch_cap' }, observed())
    expect(isFailing(f, false)).toBe(true)
  })
})
```

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -5
```

**200 tests** (180 + 20), all green.

---

## Step 4 — the 12 fixtures

Create these under `packages/eval/fixtures/`. All use §10's shape. `now` is pinned so the day-offsets are stable forever.

> **Two-voice note.** `F01` carries an extra `agent_b` field. §9 cut `/settings` and replaced it with *"one eval fixture that runs the same lead+messages through both agents and prints both drafts side by side in the runner's `--verbose` output"*. That's this. Only F01 has it.

**`F01_cold_buyer_21d.json`**
```json
{
  "id": "F01_cold_buyer_21d",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false,
                                "sign_off": "- Wei Ling", "sample_messages": ["no worries, take ur time. shout when ready ya"] } },
  "agent_b": { "name": "Terence Koh", "max_touches": 4,
               "voice_profile": { "formality": 5, "warmth": 2, "brevity": 1, "emoji_ok": false,
                                  "sign_off": "Best regards,\nTerence Koh", "sample_messages": ["Thank you for your response. Please do not hesitate to contact me should you require any further clarification."] } },
  "lead": { "name": "Marcus", "source": "propertyguru", "touch_count": 1,
            "created_at": "2026-06-20T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-09T14:02:00+08:00",
      "body": "hi saw ur listing, im looking at katong area, budget around 1.5m for a 3 bedder" },
    { "direction": "outbound", "sent_at": "2026-07-09T14:20:00+08:00",
      "body": "Hi Marcus! Sure, I have a few options in D15. When are you looking to move?" }
  ],
  "expect": {
    "facts_extracted": [
      { "key": "districts", "value": ["D15"] },
      { "key": "budget_max", "value": 1500000 },
      { "key": "bedrooms", "value": 3 },
      { "key": "transaction_type", "value": "buy" }
    ],
    "facts_absent": ["timeline"],
    "state": "cold",
    "rule_fired": "gap_fill",
    "strategy": "fill_missing_fact",
    "no_hallucinated_entities": true,
    "tone_acceptable": true
  }
}
```

**`F02_cold_buyer_complete.json`** — all four required facts present, so no gap and `listing_hook` (50) wins. **All four must be asserted**, `timeline` included: `listing_hook` requires `fact_gaps_len == 0`, so if `timeline` is missing the lead falls to `gap_fill` (60) and the fixture fails on `rule_fired` with no clue why. Asserting it makes the premise checkable rather than assumed.
```json
{
  "id": "F02_cold_buyer_complete",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Priya", "source": "99co", "touch_count": 1, "created_at": "2026-06-10T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-09T10:00:00+08:00",
      "body": "hi, buying. budget max 1.2m, looking at D19 only" },
    { "direction": "inbound", "sent_at": "2026-07-09T10:05:00+08:00",
      "body": "3 bedroom, hoping to move in the next 3 months" },
    { "direction": "outbound", "sent_at": "2026-07-10T09:00:00+08:00",
      "body": "noted Priya! ill shortlist some and revert" }
  ],
  "expect": {
    "facts_extracted": [
      { "key": "transaction_type", "value": "buy" },
      { "key": "budget_max", "value": 1200000 },
      { "key": "districts", "value": ["D19"] },
      { "key": "timeline", "value": "1_3_months" }
    ],
    "state": "cold",
    "rule_fired": "listing_hook",
    "strategy": "new_listing_hook",
    "no_hallucinated_entities": true,
    "tone_acceptable": true
  }
}
```

**`F03_new_ad_lead.json`** — zero messages, so `classify()` returns `new` (see amendment A4).
```json
{
  "id": "F03_new_ad_lead",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Jonathan", "source": "meta_ad", "touch_count": 0, "created_at": "2026-07-29T09:00:00+08:00" },
  "messages": [],
  "expect": {
    "state": "new",
    "rule_fired": "new_ad_lead",
    "strategy": "instant_qualify",
    "no_hallucinated_entities": true,
    "draft_omits": ["$"],
    "tone_acceptable": true
  }
}
```

**`F05_opt_out.json`**
```json
{
  "id": "F05_opt_out",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Kelvin", "source": "propertyguru", "touch_count": 1,
            "created_at": "2026-06-25T09:00:00+08:00", "opted_out": true },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-25T18:00:00+08:00", "body": "pls stop messaging me, already bought" }
  ],
  "expect": { "state": "do_not_contact", "rule_fired": "hard_suppress", "no_draft": true }
}
```

**`F07_snoozed.json`** — `snooze_until` is set on the lead, so the priority-95 rule suppresses.
```json
{
  "id": "F07_snoozed",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Daniel", "source": "referral", "touch_count": 1,
            "created_at": "2026-06-25T09:00:00+08:00", "snooze_until": "2026-08-25T10:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-26T12:00:00+08:00", "body": "busy now, call me next month" }
  ],
  "expect": { "rule_fired": "snoozed", "no_draft": true, "snooze_until_set": true }
}
```

**`F08_warm_human_handles.json`**
```json
{
  "id": "F08_warm_human_handles",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Siti", "source": "referral", "touch_count": 2, "created_at": "2026-07-01T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-28T20:00:00+08:00", "body": "yes im keen! sat afternoon can?" },
    { "direction": "outbound", "sent_at": "2026-07-29T10:00:00+08:00", "body": "sat 2pm works! ill confirm and revert" }
  ],
  "expect": { "state": "warm", "rule_fired": "warm_human_handles", "no_draft": true }
}
```

**`F09_touch_cap.json`**
```json
{
  "id": "F09_touch_cap",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Wesley", "source": "manual", "touch_count": 4, "created_at": "2026-05-20T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-06-15T10:00:00+08:00", "body": "hi, looking around for now" }
  ],
  "expect": { "rule_fired": "touch_cap", "no_draft": true }
}
```

**`F12_budget_under_1m.json`** — "under 1m" is a max only, never a min.
```json
{
  "id": "F12_budget_under_1m",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Aisha", "source": "99co", "touch_count": 1, "created_at": "2026-06-15T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-08T11:00:00+08:00",
      "body": "hi im looking to buy something under 1m in D19, 2 bedder is fine" }
  ],
  "expect": {
    "facts_extracted": [
      { "key": "budget_max", "value": 1000000 },
      { "key": "transaction_type", "value": "buy" }
    ],
    "facts_absent": ["budget_min"],
    "no_hallucinated_entities": true
  }
}
```

**`F14_contradicts_budget.json`** — exercises `superseded_at`; only the most recent value survives.
```json
{
  "id": "F14_contradicts_budget",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Farid", "source": "propertyguru", "touch_count": 1, "created_at": "2026-06-15T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-05T10:00:00+08:00",
      "body": "hi, buying in D15, my budget is around 900k" },
    { "direction": "inbound", "sent_at": "2026-07-08T10:00:00+08:00",
      "body": "actually we can stretch to 1.2m after talking to the bank" }
  ],
  "expect": {
    "facts_extracted": [
      { "key": "budget_max", "value": 1200000 },
      { "key": "transaction_type", "value": "buy" }
    ],
    "no_hallucinated_entities": true
  }
}
```

**`F18_anti_inference_tampines.json`** — **one of the two that matter most.**
```json
{
  "id": "F18_anti_inference_tampines",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Hakim", "source": "propertyguru", "touch_count": 1, "created_at": "2026-06-15T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-08T10:00:00+08:00",
      "body": "hi, i stay in tampines now, looking to buy somewhere in the east" }
  ],
  "expect": {
    "facts_extracted": [{ "key": "transaction_type", "value": "buy" }],
    "facts_absent": [{ "key": "districts", "value_not": "D18" }],
    "no_hallucinated_entities": true,
    "tone_acceptable": true
  }
}
```

**`F19_no_budget_no_district.json`** — **the other one that matters most.**
```json
{
  "id": "F19_no_budget_no_district",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Nadia", "source": "referral", "touch_count": 1, "created_at": "2026-06-15T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-08T10:00:00+08:00",
      "body": "hi! a friend passed me ur contact. thinking of buying my first place soon" },
    { "direction": "outbound", "sent_at": "2026-07-08T11:00:00+08:00",
      "body": "hi Nadia! congrats on starting the search. what are u looking for?" }
  ],
  "expect": {
    "facts_extracted": [{ "key": "transaction_type", "value": "buy" }],
    "facts_absent": ["budget_max", "districts"],
    "no_hallucinated_entities": true,
    "draft_omits": ["$"],
    "tone_acceptable": true
  }
}
```

**`F20_price_not_stated.json`**
```json
{
  "id": "F20_price_not_stated",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false, "sign_off": "- Wei Ling", "sample_messages": [] } },
  "lead": { "name": "Gerald", "source": "propertyguru", "touch_count": 1, "created_at": "2026-06-15T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound", "sent_at": "2026-07-08T10:00:00+08:00",
      "body": "hi, buying. whats the price of that unit u posted?" }
  ],
  "expect": {
    "facts_extracted": [{ "key": "transaction_type", "value": "buy" }],
    "no_hallucinated_entities": true,
    "draft_omits": ["$"],
    "tone_acceptable": true
  }
}
```

---

## Step 5 — `packages/eval/src/run.ts`

Replace the stub with exactly this content:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { Fact } from '@revive/core'
import { isFailing, pipelineError, runAssertions } from './assertions.ts'
import type { Failure, FixtureExpect, Observed } from './assertions.ts'

/**
 * §10's eval harness. `pnpm eval [--only <id>] [--verbose] [--strict]`.
 *
 * Per fixture: truncate, insert agent + lead + messages, call extract-facts,
 * call generate-drafts with the fixture's `now` (service-role auth so §8's
 * override guard admits it), run assertions, write `eval_runs`.
 *
 * Truncation cascades from `agents`, so a run DESTROYS the seeded demo data
 * (trap 1). Finish with `pnpm seed`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. Get it from `supabase status -o json`.')
}
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const verbose = args.includes('--verbose')
const strict = args.includes('--strict')

interface Fixture {
  id: string
  now: string
  agent: Record<string, unknown>
  agent_b?: Record<string, unknown>
  lead: Record<string, unknown>
  messages: { direction: 'inbound' | 'outbound'; sent_at: string; body: string }[]
  expect: FixtureExpect
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture)
    .filter((f) => !only || f.id === only)
}

/** §10's per-fixture reset. agents -> leads -> messages/lead_facts/drafts all cascade. */
async function truncate(): Promise<void> {
  const { error } = await db.from('agents').delete().not('id', 'is', null)
  if (error) throw new Error(`truncate failed: ${error.message}`)
}

async function insertAgent(spec: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from('agents').insert(spec).select('id').single()
  if (error || !data) throw new Error(`inserting agent failed: ${error?.message}`)
  return data.id
}

async function insertLeadWithMessages(f: Fixture, agentId: string): Promise<string> {
  const { data: lead, error } = await db
    .from('leads')
    .insert({
      ...f.lead,
      agent_id: agentId,
      last_inbound_at: [...f.messages].reverse().find((m) => m.direction === 'inbound')?.sent_at ?? null,
      last_outbound_at: [...f.messages].reverse().find((m) => m.direction === 'outbound')?.sent_at ?? null,
    })
    .select('id')
    .single()
  if (error || !lead) throw new Error(`inserting lead failed: ${error?.message}`)

  if (f.messages.length) {
    const { error: msgErr } = await db.from('messages').insert(
      f.messages.map((m) => ({
        lead_id: lead.id,
        agent_id: agentId,
        direction: m.direction,
        body: m.body,
        sent_at: m.sent_at,
        provider: 'mock',
      })),
    )
    if (msgErr) throw new Error(`inserting messages failed: ${msgErr.message}`)
  }
  return lead.id
}

function fn(name: string, body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    // Trap 5 — §8 admits a client-supplied `now` only for the service role.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  })
}

interface RunResult {
  id: string
  failures: Failure[]
  latency_ms: number
  cost_usd: number
  prompt_version: string
  draft: string | null
}

/**
 * `Response.json()` is typed `unknown` under this tsconfig, so the two edge
 * function payloads get explicit shapes rather than a blanket `any`. Both are
 * partial on purpose — the runner should degrade to zeros on a malformed
 * response, not throw.
 */
interface ExtractResponse {
  inserted?: number
  rejected?: number
  usage?: { latency_ms?: number; cost_usd?: number; prompt_version?: string }
}

interface TraceShape {
  rule_fired?: string
  strategy?: string
  usage?: {
    write?: { latency_ms?: number; cost_usd?: number }
    tone?: { latency_ms?: number; cost_usd?: number }
  }
  guardrail?: { tone?: 'pass' | 'fail' | null }
  prompt_versions?: { write?: string }
}

interface GenerateResponse {
  results?: { outcome?: string; trace?: TraceShape }[]
}

async function runFixture(f: Fixture): Promise<RunResult> {
  await truncate()
  const agentId = await insertAgent(f.agent)
  const leadId = await insertLeadWithMessages(f, agentId)

  const exRes = await fn('extract-facts', { lead_id: leadId, force: true })
  const exBody: ExtractResponse = exRes.ok ? ((await exRes.json()) as ExtractResponse) : {}
  const extract = { ok: exRes.ok, inserted: exBody.inserted ?? 0, rejected: exBody.rejected ?? 0 }

  // Trap 3 — structural hard fail before any other assertion runs.
  const hard = pipelineError(f.expect, extract)

  const gdRes = await fn('generate-drafts', { agent_id: agentId, lead_ids: [leadId], now: f.now })
  const gdBody: GenerateResponse = gdRes.ok ? ((await gdRes.json()) as GenerateResponse) : {}
  const result = gdBody.results?.[0] ?? null
  const trace: TraceShape = result?.trace ?? {}

  const { data: factRows } = await db.from('lead_facts').select('*').eq('lead_id', leadId)
  const { data: draftRows } = await db.from('drafts').select('body').eq('lead_id', leadId)
  // Trap 6 — §6.1: assert on the stored column, not trace.state.
  const { data: leadRow } = await db
    .from('leads')
    .select('state, snooze_until')
    .eq('id', leadId)
    .single()

  const observed: Observed = {
    facts: (factRows ?? []) as Fact[],
    state: leadRow?.state ?? null,
    rule_fired: trace.rule_fired ?? null,
    strategy: trace.strategy ?? null,
    outcome: result?.outcome ?? null,
    draftBody: draftRows?.[0]?.body ?? null,
    draftRowCount: draftRows?.length ?? 0,
    toneVerdict: trace.guardrail?.tone ?? null,
    snoozeUntil: leadRow?.snooze_until ?? null,
  }

  const failures = hard ? [hard] : runAssertions(f.expect, observed)

  const usage = trace.usage ?? {}
  const latency_ms =
    (exBody.usage?.latency_ms ?? 0) + (usage.write?.latency_ms ?? 0) + (usage.tone?.latency_ms ?? 0)
  const cost_usd =
    (exBody.usage?.cost_usd ?? 0) + (usage.write?.cost_usd ?? 0) + (usage.tone?.cost_usd ?? 0)

  // §9's two-voice comparison: same lead + messages, second agent, side by side.
  let draftB: string | null = null
  if (f.agent_b) {
    const agentBId = await insertAgent(f.agent_b)
    const leadBId = await insertLeadWithMessages(f, agentBId)
    await fn('extract-facts', { lead_id: leadBId, force: true })
    await fn('generate-drafts', { agent_id: agentBId, lead_ids: [leadBId], now: f.now })
    const { data: rows } = await db.from('drafts').select('body').eq('lead_id', leadBId)
    draftB = rows?.[0]?.body ?? null
  }

  if (verbose) {
    console.log(`\n── ${f.id} ─────────────────────────────`)
    if (observed.draftBody) console.log(`[${f.agent.name}]\n${observed.draftBody}\n`)
    if (draftB) console.log(`[${(f.agent_b as { name: string }).name}]\n${draftB}\n`)
    for (const fail of failures) {
      console.log(`  ${fail.soft ? '[soft] ' : ''}${fail.assertion}: ${fail.detail}`)
    }
  }

  return {
    id: f.id,
    failures,
    latency_ms,
    cost_usd,
    prompt_version: trace.prompt_versions?.write ?? exBody.usage?.prompt_version ?? 'n/a',
    draft: observed.draftBody,
  }
}

async function main() {
  const fixtures = loadFixtures()
  if (fixtures.length === 0) {
    console.error(only ? `No fixture matched --only ${only}` : 'No fixtures found')
    process.exit(1)
  }

  const run_id = crypto.randomUUID()
  const results: RunResult[] = []
  for (const f of fixtures) {
    results.push(await runFixture(f))
  }

  console.log('\nfixture                         | pass | failed assertions            | latency | cost')
  console.log('--------------------------------|------|------------------------------|---------|--------')
  for (const r of results) {
    const hardFail = isFailing(r.failures, strict)
    const names = r.failures.map((f) => (f.soft ? `[soft]${f.assertion}` : f.assertion)).join(', ')
    console.log(
      `${r.id.padEnd(31)} | ${(hardFail ? 'FAIL' : 'pass').padEnd(4)} | ${names.slice(0, 28).padEnd(28)} | ${String(r.latency_ms).padStart(6)}ms | $${r.cost_usd.toFixed(4)}`,
    )
    await db.from('eval_runs').insert({
      run_id,
      fixture_id: r.id,
      passed: !hardFail,
      failures: r.failures,
      latency_ms: r.latency_ms,
      cost_usd: r.cost_usd,
      prompt_version: r.prompt_version,
    })
  }

  const failed = results.filter((r) => isFailing(r.failures, strict))
  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0)
  console.log(`\n${results.length - failed.length}/${results.length} passed · $${totalCost.toFixed(4)} total`)
  if (failed.length) {
    console.log('\nRe-seed before demoing:  pnpm seed')
    process.exit(1)
  }
  console.log('\nRe-seed before demoing:  pnpm seed')
}

main().catch((err) => {
  console.error(`\neval failed: ${err.message}`)
  process.exit(1)
})
```

Then point the root script at an env file so the keys are available:

```json
    "eval": "node --env-file-if-exists=.env.local node_modules/.bin/tsx packages/eval/src/run.ts",
```

> If that indirection is awkward on your machine, the equivalent is
> `pnpm --filter @revive/eval start` with the two keys exported in your shell.
> `tsx` is already a devDependency of `packages/eval`.

---

## Step 6 — run it

```bash
cd $REPO
supabase start
supabase functions serve --no-verify-jwt --env-file .env.local   # leave running
```

In a second terminal, start with one cheap fixture:

```bash
cd $REPO
pnpm eval --only F05_opt_out
```

F05 makes **no LLM calls at all** (the lead is opted out, so §8 suppresses before the write prompt), which makes it the right first target — it exercises truncate, insert, both function calls, the assertions, `eval_runs`, and the table output for free.

Then the two that matter most, then everything:

```bash
cd $REPO
pnpm eval --only F18_anti_inference_tampines --verbose
pnpm eval --only F19_no_budget_no_district --verbose
pnpm eval                       # all 12 — ~36 LLM calls, costs real money
pnpm seed                       # trap 1: put the demo data back
```

Expected shape:

```
fixture                         | pass | failed assertions            | latency | cost
--------------------------------|------|------------------------------|---------|--------
F01_cold_buyer_21d              | pass |                              |   8100ms | $0.0102
...
12/12 passed · $0.0９xx total
```

### Verify the two-voice output

```bash
cd $REPO && pnpm eval --only F01_cold_buyer_21d --verbose
```

Prints both drafts under `[Wei Ling]` and `[Terence Koh]`. They must read **visibly differently** — that is §12's *"Same lead + two voice profiles produces two visibly different drafts"* checkbox, and the whole reason `/settings` was cut.

### Verify the hard-fail actually fires

A green suite you've never seen go red proves nothing. Temporarily point a fixture at a nonsense expectation and confirm it fails:

```bash
cd $REPO
sed -i 's/"value": \["D15"\]/"value": ["D99"]/' packages/eval/fixtures/F01_cold_buyer_21d.json
pnpm eval --only F01_cold_buyer_21d; echo "exit: $?"
sed -i 's/"value": \["D99"\]/"value": ["D15"]/' packages/eval/fixtures/F01_cold_buyer_21d.json
```

Expect a `facts_extracted` failure and **exit 1**.

---

## Step 7 — full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0; `pnpm test` reports **200 tests** (180 + 20 assertion tests).

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `TS5097 ... allowImportingTsExtensions` | Step 1 skipped | Trap 2 — and note `pnpm eval` still *runs*, so only typecheck catches it |
| `pnpm eval` green but demo data gone | Expected | Trap 1 — `pnpm seed` |
| `400 \`now\` override requires dry_run` | Missing `Authorization` header | Trap 5 — service-role Bearer token |
| Every fixture fails `state` | Asserting `trace.state` instead of the column | Trap 6 |
| `pipeline_error` on every fixture | `extract-facts` erroring — usually no `ANTHROPIC_API_KEY` | Check `supabase functions serve --env-file .env.local` |
| `facts_extracted districts expected ["D15"], got ["d15"]` | Case drift from the model | The assertion is deep-equal by design; normalise in `evidence.ts`, not here |
| Tone failures turning the build red | `--strict` left on | Trap 4 — soft by default |
| `SUPABASE_SERVICE_ROLE_KEY is not set` | Script not loading `.env.local` | Step 5's script line |

---

## Step 8 — Acceptance and commit

### Checklist

- [ ] `allowImportingTsExtensions` added to `packages/eval/tsconfig.json`
- [ ] All 8 §10 assertion types implemented as pure functions
- [ ] `pipeline_error` runs **before** other assertions and treats `rejected > 0` as "ran"
- [ ] `tone_acceptable` marked `[soft]` and excluded from exit code unless `--strict`
- [ ] `state` asserted from the stored column, not `trace.state`
- [ ] All 12 fixtures present, `now` pinned in each
- [ ] F01 carries `agent_b`; `--verbose` prints both drafts side by side
- [ ] `--only` and `--verbose` both work
- [ ] `eval_runs` written per fixture with `prompt_version`
- [ ] Exit code 1 on any hard failure — **proven by planting one**
- [ ] `pnpm seed` run afterwards so the demo data is back
- [ ] `pnpm typecheck`, `pnpm test` (200), `pnpm --filter @revive/web build` all exit 0

### Expected tree

```
$REPO/packages/eval/
├── tsconfig.json              # edited: +allowImportingTsExtensions
├── src/
│   ├── assertions.ts          # new
│   ├── assertions.test.ts     # new
│   └── run.ts                 # replaced (was a stub)
└── fixtures/                  # 12 new .json files
```

Plus the `eval` script line in the root `package.json`.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 12: eval harness, assertions, 12 fixtures"
```

Then update **Current state** in `CLAUDE.md`.

---

## Next

**`0005_approve_draft.sql`** (amendment A1) is the last thing between here and task 13's queue UI, and it is now genuinely blocking. §8 specifies it: the quiet-hours check (SGT hour within `[quiet_hours_start, quiet_hours_end)`, else 409 `outside_quiet_hours`), the mock send, the outbound `messages` insert, and `touch_count += 1` / `last_outbound_at` / `resolved_at` / `status` — all in one transaction, which is the entire reason it isn't a client-side `PATCH`.

**Task 13 — `/queue` + `DraftCard`** + approve/edit/skip. Approve calls `approve_draft`; skip stays a plain `PATCH` because it changes no cadence state.

**Task 16 depends on this task's baseline.** Once these fixtures are green, `write-v1` is the text the planted regression regresses *from*. §11: plant `write-v2`, verify it turns F19 and/or F20 red on `no_hallucinated_entities`, revert. That only means something if the baseline was green first and the prompt hasn't moved since.

**One known issue to keep in view:** a PR review on task 11 found that `districts` arrays are stored in whatever order the model returns, so a re-extraction that reorders them counts as a changed fact and triggers a spurious supersede. It doesn't affect these fixtures (each runs against a fresh truncate, and F14 contradicts on `budget_max`, not districts), but it will show up as history churn once `ingest-inbound` runs repeatedly against a long-lived lead.
