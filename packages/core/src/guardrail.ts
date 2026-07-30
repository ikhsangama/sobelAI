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

/**
 * Step 2: "one point two million", "two million".
 *
 * // SPEC-GAP: an earlier version of this file also accepted a bare article
 * — `(?:(${UNITS_ALT})|a)` — so "thousand"/"million" alone (preceded only by
 * "a") would also match. That's not in §6.4's word map ("one"…"ten",
 * "hundred", "thousand", "million" — no article), and it collided with
 * ordinary English: "thanks a million for getting back to me" and "one in a
 * million" both normalised to 1000000 and failed G3, on exactly the warm,
 * on-brand phrasing §7.2's write prompt is tuned to produce. Requiring one
 * of the ten unit words removes the false positive; the residual gap (a
 * bare "asking a million" going unchecked) is the same class of limitation
 * §6.4 step 5 already accepts for a token-level check.
 */
const WORD_NUM_RE = new RegExp(
  `\\b(${UNITS_ALT})(?:\\s+point\\s+(${UNITS_ALT}))?\\s+(${SCALES_ALT})\\b`,
  'gi',
)

/**
 * Step 1, with a boundary the contract's version omits, and the digit
 * portion locked so it can never partially back off (see below).
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
 *
 * Two narrower fixes were each tried and each reopened a variant of the same
 * bug before landing on this one:
 *
 * 1. `(?![a-z])` alone: `\d+` is greedy, and a lookahead-only fix lets a
 *    failed match backtrack into a *shorter* digit run instead of being
 *    rejected outright — "1500000SGD" matched only "150000" (10x off, a
 *    number that never appeared in the draft), because giving back one
 *    digit left another digit as the "next character", which isn't in
 *    `[a-z]` and so satisfied the lookahead anyway.
 * 2. Widening to `(?![\w.])` (`\w` covers digits, closing #1) plus a leading
 *    `(?<![\w.])`: this closed #1, but excluding `.` from the lookahead also
 *    rejects a number immediately followed by a sentence-ending period with
 *    no space — "I have a unit at 9.9mil." normalised to nothing at all, so
 *    a fabricated $9.9m against a $1.5m fact passed `guardrail()` clean.
 *    Dropping `.` from the lookahead to fix *that* reopens #1's failure mode
 *    through the decimal point instead of a letter: "1500.5mSGD" backtracks
 *    past the ".5" to a bare, wrong "1500".
 *
 * The actual problem is that a plain lookahead can't distinguish "the digit
 * run gave up part of itself to satisfy the boundary" from "the boundary
 * check ran once, cleanly, after the full number." Fixed by emulating an
 * atomic group — `(?=(\d+(?:\.\d+)?))\1` matches the maximal digit+decimal
 * span once inside a lookahead (capturing it to group 1), then a
 * backreference (`\1`, not a new group — capture-group numbering for `m[1]`/
 * `m[2]` is unaffected) consumes exactly that text. If the trailing
 * lookahead then fails, there is nothing left to shrink: the whole match
 * attempt fails outright rather than retrying with less of the number, and
 * the leading `(?<![\w.])` stops the engine from restarting mid-run at the
 * next character instead. Verified against all three prior cases at once:
 * "1500000SGD"/"1234A"/"1500.5mSGD" now correctly match nothing, while
 * "9.9mil.", "900k.", and "1500000." (all with no space before the period)
 * now correctly extract 9900000 / 900000 / 1500000.
 */
const NUM_RE = /(?<![\w.])(?=(\d+(?:\.\d+)?))\1\s*(k|m|mil|million|psf)?(?![\w])/gi

/**
 * Step 4: `$`-amounts, checked at any magnitude (see trap 5).
 *
 * Same atomic-group fix as NUM_RE, and the same reasoning: a plain
 * `(?![\w.])` lookahead excluded genuine sentence-final amounts like
 * "$9.9mil." (no space before the period) exactly as it did for NUM_RE,
 * confirmed on this function directly — `extractMoney('at $9.9mil.')`
 * returned `[]`. No leading lookbehind needed here, unlike NUM_RE: every
 * match must start at a literal `$`, which is a unique anchor, so there is
 * no alternate start position mid-digit-run for the engine to retry at.
 */
const MONEY_RE = /\$\s?(?=(\d[\d,]*(?:\.\d+)?))\1\s*(k|m|mil|million)?(?![\w])/gi

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
    const unit = WORD_UNITS[m[1]!.toLowerCase()]!
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

/**
 * `$`-amounts, at any magnitude — trap 5.
 *
 * Reads the digit value straight from the atomic-captured group 1, rather
 * than stripping non-digit characters out of the whole match — the earlier
 * version of this function did `m[0].replace(/[^\d.]/g, '')` and read the
 * suffix from `m[1]`, which was correct only while `MONEY_RE` had no digit
 * capture group of its own. Adding the atomic-emulation lookahead gave
 * `MONEY_RE` a real group 1 (the digits) and pushed the suffix to group 2;
 * `m[1]` at that point still parsed (a same-looking numeric string) but was
 * silently the wrong value — `extractMoney('at $9.9mil.')` returned `[9.9]`
 * instead of `[9900000]`, because `m[1] ?? ''` was being fed to
 * `applySuffix` as the *suffix* argument, where it matched none of the k/m/
 * mil/million cases and applied no multiplier at all.
 */
export function extractMoney(draft: string): number[] {
  const text = stripThousandsSeparators(draft)
  return [...text.matchAll(MONEY_RE)].map((m) => applySuffix(parseFloat(m[1]!), m[2] ?? ''))
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
