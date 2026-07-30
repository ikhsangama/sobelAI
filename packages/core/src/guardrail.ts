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
