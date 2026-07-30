import { describe, expect, it } from 'vitest'
import { validateFacts } from './evidence'

const MESSAGES = [
  { body: 'hi saw ur listing on pg, still available ah' },
  { body: 'looking at katong area, budget around 1.5m for a 3 bedder' },
  { body: 'i stay in tampines, looking to buy in the east' },
]

function fact(over: Partial<Record<string, unknown>> = {}) {
  return {
    key: 'budget_max',
    value: 1500000,
    confidence: 0.9,
    source_message_index: 1,
    evidence: 'budget around 1.5m',
    ...over,
  }
}

describe('validateFacts — layer 2 (verbatim substring)', () => {
  it('accepts a fact whose evidence is a verbatim span of the cited message', () => {
    const r = validateFacts([fact()], MESSAGES)
    expect(r.rejections).toEqual([])
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.key).toBe('budget_max')
  })

  it('is case-insensitive, per §5 ("includes(evidence.toLowerCase())")', () => {
    const r = validateFacts([fact({ evidence: 'BUDGET AROUND 1.5M' })], MESSAGES)
    expect(r.accepted).toHaveLength(1)
  })

  it('rejects fabricated evidence with evidence_mismatch — §5 layer 4', () => {
    const r = validateFacts([fact({ evidence: 'my budget is 1.5 million dollars' })], MESSAGES)
    expect(r.accepted).toEqual([])
    expect(r.rejections).toEqual([
      { key: 'budget_max', reason: 'evidence_mismatch', evidence: 'my budget is 1.5 million dollars' },
    ])
  })

  it('rejects a span that is verbatim in a DIFFERENT message than the one cited', () => {
    // The text exists in messages[1], but the model pointed at messages[0].
    const r = validateFacts([fact({ source_message_index: 0 })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('evidence_mismatch')
  })

  it('rejects an out-of-range source_message_index instead of throwing', () => {
    const r = validateFacts([fact({ source_message_index: 99 })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('bad_message_index')
  })
})

describe('validateFacts — layer 3 (numeric cross-check)', () => {
  it('rejects verbatim evidence whose number contradicts the value — §5 layer 4', () => {
    // §5's own example: evidence "around 1.5m", value 3000000.
    const r = validateFacts([fact({ value: 3000000, evidence: 'budget around 1.5m' })], MESSAGES)
    expect(r.accepted).toEqual([])
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('allows ±2% so "1.2m" matches 1200000', () => {
    const msgs = [{ body: 'buying. budget max 1.2m, looking at D19 only' }]
    const r = validateFacts(
      [fact({ value: 1200000, evidence: 'budget max 1.2m', source_message_index: 0 })],
      msgs,
    )
    expect(r.accepted).toHaveLength(1)
  })

  it('accepts a bedrooms fact — the ≥1000 floor must not apply here', () => {
    // Regression guard for trap 2 / amendment A6: `extractNumbers` filters to
    // >= 1000 for G3, which finds no number in "a 3 bedder" and would reject
    // every legitimate bedrooms fact. validateFacts uses normalizeNumbers.
    const r = validateFacts([fact({ key: 'bedrooms', value: 3, evidence: 'a 3 bedder' })], MESSAGES)
    expect(r.rejections).toEqual([])
    expect(r.accepted[0]!.value).toBe(3)
  })

  it('still rejects a bedrooms fact whose number is wrong', () => {
    const r = validateFacts([fact({ key: 'bedrooms', value: 5, evidence: 'a 3 bedder' })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('rejects a numeric key whose value is not a number', () => {
    const r = validateFacts(
      [fact({ key: 'budget_max', value: '1.5m', evidence: 'budget around 1.5m' })],
      MESSAGES,
    )
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('coerces a string-valued districts into §5s declared string[]', () => {
    // §7.1 says "return the DXX code" without saying array-or-scalar, so the
    // model returns either. A bare string is invisible to guardrail.ts's
    // `Array.isArray(f.value)` check, so G3 then flags a truthful district as
    // invented — observed live on a real extraction.
    const r = validateFacts(
      [fact({ key: 'districts', value: 'D15', evidence: 'looking at katong area' })],
      MESSAGES,
    )
    expect(r.rejections).toEqual([])
    expect(r.accepted[0]!.value).toEqual(['D15'])
  })

  it('leaves an already-correct districts array untouched', () => {
    const r = validateFacts(
      [fact({ key: 'districts', value: ['D15', 'D16'], evidence: 'looking at katong area' })],
      MESSAGES,
    )
    expect(r.accepted[0]!.value).toEqual(['D15', 'D16'])
  })

  it('rejects a districts value that is neither a string nor a string[]', () => {
    for (const bad of [15, null, {}, [], ['D15', 7]]) {
      const r = validateFacts(
        [fact({ key: 'districts', value: bad, evidence: 'looking at katong area' })],
        MESSAGES,
      )
      expect(r.accepted, `value ${JSON.stringify(bad)} should be rejected`).toEqual([])
      expect(r.rejections[0]!.reason).toBe('bad_shape')
    }
  })

  it('does not numeric-cross-check non-numeric keys', () => {
    // "looking at katong area" contains no digits at all; districts is not in
    // NUMERIC_CROSS_CHECK_KEYS, so layer 3 must not touch it.
    const r = validateFacts(
      [fact({ key: 'districts', value: ['D15'], evidence: 'looking at katong area' })],
      MESSAGES,
    )
    expect(r.accepted).toHaveLength(1)
  })
})

describe('validateFacts — shape and key guards', () => {
  it('rejects a key outside FACT_KEYS', () => {
    const r = validateFacts([fact({ key: 'favourite_colour' })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('unknown_key')
  })

  it('rejects empty or whitespace-only evidence rather than accepting it', () => {
    expect(validateFacts([fact({ evidence: '' })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
    expect(validateFacts([fact({ evidence: '   ' })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
  })

  it('rejects confidence outside 0..1', () => {
    expect(validateFacts([fact({ confidence: 1.5 })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
    expect(validateFacts([fact({ confidence: -0.1 })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
  })

  it('returns empty results for a non-array payload instead of throwing', () => {
    expect(validateFacts(null, MESSAGES)).toEqual({ accepted: [], rejections: [] })
    expect(validateFacts({ facts: [] }, MESSAGES)).toEqual({ accepted: [], rejections: [] })
  })

  it('keeps going after a rejection — one bad fact does not drop the good ones', () => {
    const r = validateFacts(
      [
        fact({ evidence: 'totally fabricated' }),
        fact({ key: 'bedrooms', value: 3, evidence: 'a 3 bedder' }),
      ],
      MESSAGES,
    )
    expect(r.accepted).toHaveLength(1)
    expect(r.rejections).toHaveLength(1)
  })
})
