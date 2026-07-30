import { describe, expect, it } from 'vitest'
import type { Fact } from './types'
import { extractMoney, extractNumbers, guardrail } from './guardrail'

function fact(key: string, value: unknown, overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-id',
    lead_id: 'lead-id',
    agent_id: 'agent-id',
    key,
    value,
    confidence: 0.9,
    source_message_id: 'message-id',
    evidence: 'evidence span',
    extracted_at: '2026-07-30T00:00:00Z',
    superseded_at: null,
    ...overrides,
  }
}

/** Marcus from the fixtures: 1.5m budget, 3 bedrooms, D15. */
const FACTS: Fact[] = [
  fact('budget_max', 1500000),
  fact('bedrooms', 3),
  fact('districts', ['D15']),
]

/** Pads a draft past MIN_DRAFT_CHARS so G1 never masks the check under test. */
function body(text: string): string {
  return text.length >= 40 ? text : text + ' '.repeat(40 - text.length)
}

// ---------------------------------------------------------------------------
// G3's normalizer — §6.4's five steps, written first because everything else
// in the anti-hallucination story rests on them.
// ---------------------------------------------------------------------------

describe('G3 normalizer — step 1: suffix multiplication before filtering', () => {
  it('multiplies a k suffix', () => {
    expect(extractNumbers('asking 900k here')).toEqual([900000])
  })

  it('multiplies m / mil / million suffixes', () => {
    expect(extractNumbers('at 1.5m')).toEqual([1500000])
    expect(extractNumbers('at 1.5 mil')).toEqual([1500000])
    expect(extractNumbers('at 1.5 million')).toEqual([1500000])
  })

  it('would miss a fabricated price if multiplication ran after the filter', () => {
    // 1.5 and 900 are both < 1000 unnormalised — this is why step 1 is first.
    expect(extractNumbers('at 1.5m')).not.toEqual([])
    expect(extractNumbers('asking 900k')).not.toEqual([])
  })
})

describe('G3 normalizer — step 2: word numbers', () => {
  it('handles "one point two million"', () => {
    expect(extractNumbers('about one point two million lah')).toEqual([1200000])
  })

  it('handles a bare scale word', () => {
    expect(extractNumbers('roughly two million')).toEqual([2000000])
  })

  it('drops word numbers under the threshold', () => {
    expect(extractNumbers('three hundred people came')).toEqual([])
  })
})

describe('G3 normalizer — step 3: the 2020–2035 year whitelist', () => {
  it('ignores a bare year in range', () => {
    expect(extractNumbers('the 2026 outlook is steady')).toEqual([])
    expect(extractNumbers('by 2035 completion')).toEqual([])
  })

  it('does not whitelist a 4-digit number outside the range', () => {
    expect(extractNumbers('unit 2050 is available')).toEqual([2050])
  })

  it('still whitelists a year followed by a word starting with m', () => {
    // Regression for SPEC-GAP bug A: without the (?![a-z]) the `m` of
    // "market" attaches, the year stops being bare, the whitelist never
    // applies, and 2026000000 fails — on market_update drafts specifically.
    expect(extractNumbers('the 2026 market has been quiet')).toEqual([])
  })
})

describe('G3 normalizer — SPEC-GAP bug A: suffixes need a word boundary', () => {
  it('does not treat the first letter of the next word as a suffix', () => {
    expect(extractNumbers('give me 3 months to decide')).toEqual([])
    expect(extractNumbers('900 metres to the MRT')).toEqual([])
    expect(extractNumbers('5 mins walk')).toEqual([])
  })

  it('still applies a genuine suffix', () => {
    expect(extractNumbers('1.5m in D15')).toEqual([1500000])
    expect(extractNumbers('900k for the 3 bedder')).toEqual([900000])
  })
})

describe('G3 normalizer — SPEC-GAP bug B: comma-separated prices', () => {
  it('reads $1,200,000 as one token instead of 1 / 200 / 000', () => {
    expect(extractNumbers('the price is $1,200,000 total')).toEqual([1200000])
  })

  it('closes the bypass end to end', () => {
    // Unfixed, all three fragments are < 1000 so G3 checks nothing and this
    // fabricated price passes.
    const r = guardrail(body('I have one at $2,900,000 if you are keen'), FACTS)
    expect(r.pass).toBe(false)
    expect(r.failedRule).toBe('G3')
  })
})

describe('G3 normalizer — step 4: what gets extracted', () => {
  it('captures psf without multiplying it', () => {
    expect(extractNumbers('1200 psf is fair')).toEqual([1200])
  })

  it('checks $-amounts below 1000 too (trap 5)', () => {
    expect(extractMoney('a $500 admin fee')).toEqual([500])
  })

  it('ignores small bare numbers', () => {
    expect(extractNumbers('3 bedder, 2 baths')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The five rules
// ---------------------------------------------------------------------------

describe('G1 — length', () => {
  it('fails a draft under MIN_DRAFT_CHARS', () => {
    const r = guardrail('too short', FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G1' })
  })

  it('fails a draft over MAX_DRAFT_CHARS', () => {
    const r = guardrail('a'.repeat(401), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G1' })
  })

  it('accepts the exact boundaries', () => {
    expect(guardrail('a'.repeat(40), FACTS).pass).toBe(true)
    expect(guardrail('a'.repeat(400), FACTS).pass).toBe(true)
  })
})

describe('G2 — banned phrases', () => {
  it('fails on a banned phrase regardless of case', () => {
    const r = guardrail(body('This unit is GUARANTEED to appreciate'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G2' })
  })

  it('names the offending phrase in detail', () => {
    const r = guardrail(body('you qualify for this one easily'), FACTS)
    expect(r.detail).toContain('you qualify')
  })
})

describe('G3 — invented entities', () => {
  it('fails an invented price', () => {
    const r = guardrail(body('I have a unit at 2.9m for you'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G3' })
    expect(r.detail).toContain('2900000')
  })

  it('accepts a price within 2% of a fact', () => {
    expect(guardrail(body('Your 1.5m budget still works for a 3 bedder'), FACTS).pass).toBe(true)
  })

  it('fails an invented district', () => {
    const r = guardrail(body('Something nice came up in D22 for you'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G3' })
    expect(r.detail).toContain('D22')
  })

  it('accepts a district that is in the fact set', () => {
    expect(guardrail(body('Still looking around D15 these days?'), FACTS).pass).toBe(true)
  })

  it('fails an invented date', () => {
    const r = guardrail(body('The viewing is on 2026-09-01, shall we go'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G3' })
  })

  it('ignores a fact that has been superseded', () => {
    const superseded = [
      fact('budget_max', 900000, { superseded_at: '2026-07-01T00:00:00Z' }),
      fact('districts', ['D15']),
    ]
    const r = guardrail(body('I found one at 900k for you'), superseded)
    expect(r).toMatchObject({ pass: false, failedRule: 'G3' })
  })
})

describe('G4 — no advice', () => {
  it('fails a declarative eligibility claim', () => {
    const r = guardrail(body('Your MOP has been met so you can sell now'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G4' })
  })

  it('passes when the same term is phrased as a question', () => {
    expect(guardrail(body('Has your MOP been met yet? Happy to check'), FACTS).pass).toBe(true)
  })

  it('checks per sentence, not per draft', () => {
    // The question mark belongs to a different sentence than the claim.
    const r = guardrail(body('Are you around? Your ABSD is definitely waived.'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G4' })
  })
})

describe('G5 — placeholder leak', () => {
  it('fails an unfilled template token', () => {
    const r = guardrail(body('Hi [name], I have something for you'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G5' })
  })

  it('fails a leftover TODO', () => {
    const r = guardrail(body('Following up on your search TODO check this'), FACTS)
    expect(r).toMatchObject({ pass: false, failedRule: 'G5' })
  })
})

describe('guardrail — ordering and the happy path', () => {
  it('reports the first failure, not the worst one', () => {
    // Both G2 (banned phrase) and G3 (invented price) apply; G2 runs first.
    const r = guardrail(body('guaranteed unit at 9.9m today'), FACTS)
    expect(r.failedRule).toBe('G2')
  })

  it('reports G1 ahead of everything else', () => {
    const r = guardrail('guaranteed', FACTS)
    expect(r.failedRule).toBe('G1')
  })

  it('passes a clean draft with no failedRule or detail', () => {
    const r = guardrail(body('Hi Marcus, are you still looking around D15?'), FACTS)
    expect(r.pass).toBe(true)
    expect(r.failedRule).toBeUndefined()
    expect(r.detail).toBeUndefined()
  })
})
