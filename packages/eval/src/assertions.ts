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
