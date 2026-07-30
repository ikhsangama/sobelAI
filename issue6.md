# Task 6 — `guardrail.ts` G1–G5 + tests

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 6:

> `guardrail.ts` G1–G5 + tests (§6.4 — quiet hours and no-double-send are no longer here, see §6.4 and §8). Write G3's five normalizer tests first — it's the check everything else rests on.

**Outcome:** the deterministic half of the guardrail — five checks run in order, first failure wins. G3 is the one the repo's whole anti-hallucination story rests on: every number, price, district and date in a draft must trace back to an extracted fact.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| The LLM tone check | Task 11 (`generate-drafts`, after G1–G5 pass) |
| Quiet hours | Already moved to `approve_draft` (§8) — **not a guardrail** |
| No-double-send | Deleted — it duplicated the cooldown check you built in task 5 |
| `MockProvider`, `packages/llm` | Task 7 |
| Writing `needs_review` to the DB | Task 11 |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

---

## Read this before you start

### The headline: G3's regex, as literally specified, has two bugs

§6.4 specifies G3's normalizer literally — deliberately, so an implementer doesn't improvise the check the repo most depends on. **Two of its steps are wrong as written**, and both were confirmed by running the specified regex rather than reading it. Fix both, mark both `// SPEC-GAP:`, and write a test for each.

**Bug A — the suffix has no word boundary, so it eats the first letter of the next word.** The regex is `/(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?/gi`. The `m` alternative happily matches the `m` in `months`, `metres`, `mins`, `market`:

| Draft text | As specified | Should be |
|---|---|---|
| `give me 3 months to decide` | `3000000` → **fails G3** | nothing to check |
| `900 metres to the MRT` | `900000000` → **fails G3** | nothing to check |
| `5 mins walk` | `5000000` → **fails G3** | nothing to check |
| `the 2026 market has been quiet` | `2026000000` → **fails G3** | nothing to check |

Those are ordinary phrasings for this domain, so as specified the guardrail would shunt a large share of perfectly good drafts into `needs_review`. Worse, the last row **defeats step 3's own stated purpose**: step 3 whitelists bare years 2020–2035 precisely so "every `market_update` draft that mentions the current year" doesn't false-positive — but `2026 market` isn't *bare* once the stray `m` attaches, so the whitelist never applies, and `market_update` is exactly the strategy whose drafts say "market."

**Fix:** add a negative lookahead so a suffix can't be followed by more letters — `/(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?(?![a-z])/gi`. Verified: `3 months` → nothing, `1.5m in D15` → `1500000`, `900k for` → `900000`.

**Bug B — no comma handling, which is a silent bypass, not a false positive.** `$1,200,000` is the most natural way to write a Singapore price. The specified regex splits it into `1`, `200`, `000` — all below the ≥1000 threshold of step 4, so **G3 checks nothing at all and a fabricated price passes**. That is the exact failure G3 exists to prevent, and it fails open rather than closed.

**Fix:** strip thousands separators before matching — `text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')`. Verified: `$1,200,000` → `1200000`, one token.

Bug A produces noise; **bug B produces a hole**. Fix B even if you're rushed.

### Five more traps

**Trap 1 — there are five guardrails, not seven.** Older drafts had G1–G7. Quiet hours became `approve_draft`'s job (§8) because it is a *send-time* policy: a draft written at 21:00 and approved at 10:00 the next morning never actually went out during quiet hours. No-double-send was deleted outright — it was the same policy as task 5's cooldown check, enforced twice against different data. The current G4 is "no advice"; G5 is "placeholder leak".

**Trap 2 — `guardrail()` takes no `agent` and no `now`.** This follows directly from trap 1: with quiet hours gone, nothing in this file needs a clock or agent settings. If you find yourself adding a `now: Date` parameter, you are re-implementing a check that deliberately lives somewhere else.

**Trap 3 — the tone check is not in this file.** §6.4 is explicit: it's an LLM call made by `generate-drafts` (task 11) *after* G1–G5 pass. `guardrail.ts` must stay pure and dependency-free — no `packages/llm` import, which doesn't even have a `call.ts` yet (task 7).

**Trap 4 — first failure wins, and the order is G1 → G2 → G3 → G4 → G5.** Return immediately on the first failure. A draft that is both too long and contains a banned phrase reports `G1`, not `G2`. Tests below pin this.

**Trap 5 — `$500` must still be checked even though it's under 1000.** Step 4's ≥1000 floor applies to bare numbers, not to `$`-amounts. A `$`-prefixed figure is a price claim at any magnitude, so extract money separately with no floor. Otherwise "I can get it for $500 below asking" sails through.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.

---

## Step 1 — `packages/core/src/guardrail.ts`

Create the file with exactly this content. The five G3 steps are labelled in comments so they map one-to-one onto §6.4's numbered list and onto the tests in step 2.

```ts
import type { Fact } from './types'
import {
  BANNED_PHRASES,
  ELIGIBILITY_KEYWORDS,
  MAX_DRAFT_CHARS,
  MIN_DRAFT_CHARS,
} from './sg-rules'

/**
 * The deterministic half of the guardrail (§6.4). Five checks, run in order,
 * first failure wins.
 *
 * Pure: no clock, no I/O, no LLM. Quiet hours is a *send-time* policy and
 * lives in `approve_draft` (§8); the tone check is an LLM call made by
 * `generate-drafts` (task 11) only after these five pass. That is why this
 * function takes neither an agent nor a `now`.
 */
export type GuardrailRule = 'G1' | 'G2' | 'G3' | 'G4' | 'G5'

export interface GuardrailResult {
  pass: boolean
  failedRule?: GuardrailRule
  detail?: string
}

// ---------------------------------------------------------------------------
// G3 number normalizer (§6.4 steps 1–4)
// ---------------------------------------------------------------------------

const WORD_UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}
const WORD_SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1000000 }

const UNITS_ALT = Object.keys(WORD_UNITS).join('|')
const SCALES_ALT = Object.keys(WORD_SCALES).join('|')

/** Step 2: "one point two million", "two million", "a thousand". */
const WORD_NUM_RE = new RegExp(
  `\\b(?:(${UNITS_ALT})|a)(?:\\s+point\\s+(${UNITS_ALT}))?\\s+(${SCALES_ALT})\\b`,
  'gi',
)

/**
 * Step 1, with a `(?![a-z])` the contract's version omits.
 *
 * // SPEC-GAP: §6.4 gives this as `/(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?/gi`,
 * with no boundary after the suffix — so the `m` alternative matches the
 * leading letter of the *next word*. Verified: "3 months" normalises to
 * 3000000, "900 metres" to 900000000, "5 mins" to 5000000, and "the 2026
 * market" to 2026000000. All are ordinary phrasings here, so every one would
 * be flagged as an invented number. The last also defeats step 3 — a year
 * only gets whitelisted while it is *bare*, and the stray `m` stops it being
 * bare, which breaks the exact `market_update` false-positive step 3 exists
 * to prevent.
 */
const NUM_RE = /(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?(?![a-z])/gi

/** Step 4: `$`-amounts, checked at any magnitude (see trap 5). */
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s*(k|m|mil|million)?(?![a-z])/gi

const DISTRICT_RE = /\bD\d{2}\b/gi

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\b`, 'gi'),
  new RegExp(`\\b(?:${MONTHS})[a-z]*\\s+\\d{1,2}\\b`, 'gi'),
]

function applySuffix(n: number, suffix: string): number {
  const s = suffix.toLowerCase()
  if (s === 'k') return n * 1e3
  if (s === 'm' || s === 'mil' || s === 'million') return n * 1e6
  // `psf` is captured so "1200 psf" reads as one token, but it is a unit, not
  // a multiplier — §6.4 lists a multiplier only for k and m/mil/million.
  return n
}

/**
 * // SPEC-GAP: §6.4's normalizer has no comma handling, which is a silent
 * bypass rather than a false positive. "$1,200,000" — the ordinary way a
 * price is written here — splits into 1 / 200 / 000, every one of them below
 * step 4's >= 1000 floor, so G3 checks nothing and a fabricated price passes.
 * Stripping separators first makes it a single 1200000 token.
 */
function stripThousandsSeparators(text: string): string {
  return text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
}

/** Every number in the draft worth checking: >= 1000 after normalisation. */
export function extractNumbers(draft: string): number[] {
  const found: number[] = []

  // Step 2 — word numbers, before the digit pass so both feed one filter.
  for (const m of draft.matchAll(WORD_NUM_RE)) {
    const unit = m[1] ? WORD_UNITS[m[1].toLowerCase()]! : 1
    const frac = m[2] ? WORD_UNITS[m[2].toLowerCase()]! / 10 : 0
    found.push((unit + frac) * WORD_SCALES[m[3]!.toLowerCase()]!)
  }

  // Step 1 — digits, with suffix multiplication applied before any filtering.
  const text = stripThousandsSeparators(draft)
  for (const m of text.matchAll(NUM_RE)) {
    const suffix = m[2] ?? ''
    const n = applySuffix(parseFloat(m[1]!), suffix)
    // Step 3 — a *bare* 4-digit integer in 2020–2035 is a year, not a price.
    if (!suffix && Number.isInteger(n) && n >= 2020 && n <= 2035) continue
    found.push(n)
  }

  // Step 4 — only numbers >= 1000 are worth cross-checking.
  return found.filter((n) => n >= 1000)
}

/** `$`-amounts, at any magnitude — trap 5. */
export function extractMoney(draft: string): number[] {
  const text = stripThousandsSeparators(draft)
  return [...text.matchAll(MONEY_RE)].map((m) => {
    const digits = m[0].replace(/[^\d.]/g, '')
    return applySuffix(parseFloat(digits), m[1] ?? '')
  })
}

/**
 * Flattens the live fact set into the three things G3 compares against.
 * Superseded facts are excluded — a fact the lead has since contradicted is
 * not licence to quote the old number.
 */
export function factValues(facts: Fact[]): {
  numbers: number[]
  districts: string[]
  dates: string[]
} {
  const live = facts.filter((f) => !f.superseded_at)
  const numbers: number[] = []
  const districts: string[] = []
  const dates: string[] = []

  for (const f of live) {
    if (typeof f.value === 'number') numbers.push(f.value)
    if (f.key === 'districts' && Array.isArray(f.value)) {
      districts.push(
        ...f.value
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.toUpperCase()),
      )
    }
    if (f.key === 'move_in_date' && typeof f.value === 'string') {
      dates.push(f.value.toLowerCase())
    }
  }
  return { numbers, districts, dates }
}

/** §6.4 step 4: "within ±2% of a fact value, to allow 1.2m ↔ 1200000". */
function within2pct(n: number, fact: number): boolean {
  return Math.abs(n - fact) <= Math.abs(fact) * 0.02
}

// ---------------------------------------------------------------------------
// The five checks
// ---------------------------------------------------------------------------

export function guardrail(draft: string, facts: Fact[]): GuardrailResult {
  // G1 — length
  const len = draft.length
  if (len < MIN_DRAFT_CHARS) {
    return { pass: false, failedRule: 'G1', detail: `${len} chars, minimum ${MIN_DRAFT_CHARS}` }
  }
  if (len > MAX_DRAFT_CHARS) {
    return { pass: false, failedRule: 'G1', detail: `${len} chars, maximum ${MAX_DRAFT_CHARS}` }
  }

  // G2 — banned phrase (case-insensitive substring, per §4)
  const lower = draft.toLowerCase()
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      return { pass: false, failedRule: 'G2', detail: `banned phrase "${phrase}"` }
    }
  }

  // G3 — no invented numbers, amounts, districts or dates
  const { numbers, districts, dates } = factValues(facts)

  for (const n of extractNumbers(draft)) {
    if (!numbers.some((f) => within2pct(n, f))) {
      return { pass: false, failedRule: 'G3', detail: `number ${n} is not in the fact set` }
    }
  }
  for (const amount of extractMoney(draft)) {
    if (!numbers.some((f) => within2pct(amount, f))) {
      return { pass: false, failedRule: 'G3', detail: `amount $${amount} is not in the fact set` }
    }
  }
  for (const m of draft.matchAll(DISTRICT_RE)) {
    const d = m[0].toUpperCase()
    if (!districts.includes(d)) {
      return { pass: false, failedRule: 'G3', detail: `district ${d} is not in the fact set` }
    }
  }
  for (const re of DATE_RES) {
    for (const m of draft.matchAll(re)) {
      if (!dates.includes(m[0].toLowerCase())) {
        return { pass: false, failedRule: 'G3', detail: `date "${m[0]}" is not in the fact set` }
      }
    }
  }

  // G4 — no advice: an eligibility term must sit in a sentence that asks.
  for (const sentence of draft.split(/(?<=[.!?])\s+/)) {
    for (const keyword of ELIGIBILITY_KEYWORDS) {
      const re = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
      if (re.test(sentence) && !sentence.includes('?')) {
        return {
          pass: false,
          failedRule: 'G4',
          detail: `mentions "${keyword}" without asking a question`,
        }
      }
    }
  }

  // G5 — placeholder leak
  for (const marker of ['[', '{{', 'XXX', '<name>', 'TODO']) {
    if (lower.includes(marker.toLowerCase())) {
      return { pass: false, failedRule: 'G5', detail: `placeholder "${marker}"` }
    }
  }

  return { pass: true }
}
```

Two notes on choices the contract leaves open, both deliberately conservative:

- **Date matching is exact, so a legitimately-restated date can still fail.** `move_in_date` is stored ISO (`2026-09-01`), and a draft writing "1 Sep" won't string-match. That lands in `needs_review`, which is the safe direction: a false positive costs one human glance, a false negative ships an invented date. Note it and move on.
- **G4 is case-insensitive and word-boundaried.** `\bMOP\b` won't fire inside "moped", and lowercase "absd" still counts. §6.4 doesn't specify either way.

### Verify

```bash
cd $REPO
grep -c "SPEC-GAP" packages/core/src/guardrail.ts         # bugs A and B
grep -c "failedRule: 'G" packages/core/src/guardrail.ts   # the early returns
grep -c "now: Date"  packages/core/src/guardrail.ts       # trap 2
grep -c "quiet_hours" packages/core/src/guardrail.ts      # trap 1
```

Expected: `2`, `9`, `0`, `0`.

The `9` is nine early returns — G1×2 (too short, too long), G2, G3×4 (number, amount, district, date), G4, G5. The two `0`s make `grep -c` exit non-zero; that is the passing result for those two.

---

## Step 2 — `packages/core/src/guardrail.test.ts`

§6.4 says to write G3's five normalizer tests **first**, so they lead the file. Create it with exactly this content:

```ts
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
```

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -6
```

All pass. This file adds **35 tests**; treat the count as informational.

---

## Step 3 — Add `guardrail` to the barrel

In `$REPO/packages/core/src/index.ts`, add one line:

```ts
export * from './types'
export * from './sg-rules'
export * from './facts'
export * from './classify'
export * from './selectStrategy'
export * from './guardrail'
```

---

## Step 4 — Full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0. `pnpm test` should report **5 test files** — `classify`, `facts`, `leads-state-writer`, `selectStrategy`, `guardrail`.

**Do not try a `node --input-type=module` one-liner here.** `guardrail.ts` imports `./types` and `./sg-rules` at runtime, and Node's ESM loader won't resolve extensionless specifiers — same limitation as `selectStrategy.ts` in task 5. Vitest already runs this code.

---

## Failure signatures

| Symptom | Cause | Fix |
|---|---|---|
| Innocuous drafts fail G3 with numbers like `3000000` | SPEC-GAP bug A — the `(?![a-z])` lookahead is missing | Restore it in `NUM_RE`; see the headline section |
| A draft quoting `$1,200,000` passes G3 | SPEC-GAP bug B — commas not stripped | Add `stripThousandsSeparators` before matching |
| `market_update` drafts fail on the current year | Bug A defeating step 3's whitelist | Same fix as bug A |
| Every draft fails G5 | A `[` appears in your own test fixture text | G5 is a substring check; keep brackets out of drafts |
| G4 fires on a legitimate question | The `?` is in a *different* sentence than the keyword | Correct behaviour — G4 is per-sentence by design |
| `Cannot find name 'MIN_DRAFT_CHARS'` | Missing import from `./sg-rules` | Import the four constants at the top |
| Tests pass but `pnpm typecheck` fails on `m[1]` | `noUncheckedIndexedAccess` — regex groups are `string \| undefined` | Use `m[1]!` as the file above does |

---

## Step 5 — Acceptance and commit

### Checklist

- [ ] Five checks only — no quiet hours, no no-double-send, no tone check
- [ ] `guardrail()` takes `(draft, facts)` — no `agent`, no `now`
- [ ] G3's five normalizer tests written first and passing
- [ ] Both SPEC-GAP bugs fixed, each with its own regression test
- [ ] `$1,200,000` end-to-end bypass test fails the draft
- [ ] `3 months` / `900 metres` / `5 mins` / `2026 market` all produce nothing to check
- [ ] `$`-amounts under 1000 still checked
- [ ] Superseded facts excluded from the fact set
- [ ] First-failure-wins ordering pinned by tests
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all exit 0
- [ ] `packages/core/package.json` still has **no `dependencies` key**

### Expected tree

```
$REPO/packages/core/src/
├── guardrail.ts        # new
├── guardrail.test.ts   # new
└── index.ts            # edited: +./guardrail
```

Nothing under `supabase/`, `apps/`, or the other packages changes.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 6: guardrail G1-G5 + normalizer tests"
```

Then update **Current state** in `CLAUDE.md` to task 6 complete, task 7 next, and record the two G3 SPEC-GAPs in the amendment log — the comma bypass especially, since it's the one that fails *open*.

---

## Next

Task 7 — `packages/llm/src/call.ts` with usage logging and a cost table, plus `MockProvider` in core.

Three things to know:

- **Every LLM call in the repo goes through `call.ts`** (contract rule 4). It logs `{stage, model, prompt_version, input_tokens, output_tokens, latency_ms, cost_usd}`. No direct SDK calls anywhere else — the trace panel's cost and latency numbers depend on that being true.
- **`MockProvider` implements the `MessagingProvider` seam** already sitting in `types.ts` from task 3, with its `// SEAM: Unipile + Meta Cloud API coexist here` comment. Only the mock ships; it writes to `messages` with `direction='outbound'`.
- **Task 7 unblocks `0004_approve_draft.sql`** (amendment A1, renumbered in task 5). That migration lands after task 7 and before task 13.
