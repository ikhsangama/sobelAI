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

  it('does not pass vacuously when a G1 length failure masks a real G3 violation', () => {
    // guardrail() short-circuits at the first failing rule, so a draft that is
    // both too long (G1) and names a fabricated district (G3) never reaches
    // the G3 check inside guardrail() itself — this is exactly the bug the
    // old `g.failedRule === 'G3'`-only check let through as a clean pass.
    const tooLong = 'x'.repeat(401) + ' just came up in D03'
    const o = observed({
      facts: [fact({ key: 'districts', value: ['D15'] })],
      draftBody: tooLong,
    })
    const f = runAssertions({ no_hallucinated_entities: true }, o)
    expect(f).toHaveLength(1)
    expect(f[0]!.assertion).toBe('guardrail_failed')
    expect(f[0]!.detail).toContain('G1')
  })

  it('routes a G2 banned-phrase failure under guardrail_failed, not no_hallucinated_entities', () => {
    const o = observed({
      facts: [fact({ key: 'districts', value: ['D15'] })],
      draftBody: 'guaranteed returns on this D15 unit, keen to view?',
    })
    const f = runAssertions({ no_hallucinated_entities: true }, o)
    expect(f).toHaveLength(1)
    expect(f[0]!.assertion).toBe('guardrail_failed')
    expect(f[0]!.detail).toContain('G2')
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
