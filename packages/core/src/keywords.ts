/**
 * §6.2's opt-out and snooze detection. Deterministic, no LLM, no clock —
 * `sentAt` is injected (contract rule 3), because `snooze_until` is measured
 * from when the lead said it, not from when this happens to run.
 *
 * Runs on every inbound in `ingest-inbound` (§8). An opt-out here is the one
 * irreversible write in the system: it makes `classify()` return
 * `do_not_contact`, which `hard_suppress` (priority 100) then silences
 * permanently. Nothing in the contract un-opts-out a lead. That asymmetry is
 * why the matching below is stricter than a plain substring scan.
 */

/** §6.2's opt-out list, verbatim and in the order it is written there. */
export const OPT_OUT_KEYWORDS = [
  'stop',
  'unsubscribe',
  'remove me',
  "don't message",
  'dont message',
  'stop messaging',
  'not interested anymore',
  'already bought',
  'already rented',
  'found already',
  'got already',
  'dont contact',
] as const

/** §6.2's snooze list, verbatim and in the order it is written there. */
export const SNOOZE_KEYWORDS = [
  'call me next month',
  'next month',
  'after cny',
  'after chinese new year',
  'q1',
  'next year',
  'busy now',
] as const

/** §6.2: "+30 days default; +60 for 'next year'". */
export const SNOOZE_DAYS_DEFAULT = 30
export const SNOOZE_DAYS_NEXT_YEAR = 60

const MS_PER_DAY = 86_400_000

/**
 * // SPEC-GAP: §6.2 says "lowercase and check for" these strings, which reads
 * as a plain `includes()`. Running that against ordinary property chat makes
 * `stop` fire on all of these, every one a permanent opt-out of a live lead:
 *
 *   "can i stop by the showflat this weekend?"   "is there a bus stop nearby?"
 *   "ok i will stop by tomorrow after work"      "the mrt stop is quite far"
 *   "we can stop at 1.2m if the unit is good"    "non-stop flights from changi"
 *   "i stopped looking at D15"                   "my agent stopped replying"
 *
 * `stop` is therefore matched only as an entire message — the actual SMS
 * opt-out convention, and the reading that keeps §6.2's own `stop messaging`
 * entry from being redundant. In-sentence intent is still caught by the
 * longer phrases (`stop messaging`, `dont contact`, ...), so nothing in
 * §6.2's list becomes unreachable.
 */
const WHOLE_MESSAGE_ONLY: ReadonlySet<string> = new Set(['stop'])

export interface KeywordDetection {
  /** True when an opt-out keyword fired. Irreversible downstream. */
  opted_out: boolean
  /** ISO timestamp, or null when no snooze keyword fired. */
  snooze_until: string | null
  /** §6.2: "Log which keyword fired". Null when nothing matched. */
  keyword_hit: string | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Phone keyboards emit curly apostrophes, so "don't message me" arrives as
 * "don’t message me" and would miss §6.2's straight-quoted `don't message`.
 */
function normalize(body: string): string {
  return body.toLowerCase().replace(/[‘’]/g, "'").trim()
}

/**
 * Strips only the ASCII whitespace/punctuation *framing* the message — so
 * "STOP", "stop.", "  stop  " and "stop!" all reduce to "stop" — without
 * touching interior characters of any script.
 *
 * // SPEC-GAP: an earlier version stripped every character outside
 * `[a-z0-9]`, which deletes CJK text just as readily as punctuation. §7.1
 * says explicitly "the conversation may be in Singlish or mixed
 * English/Chinese", and under that version a message that is mostly Chinese
 * but happens to mention the English word "stop" — "巴士站 stop 在哪里"
 * ("where is the bus stop"), an ordinary question — collapsed to the bare
 * string "stop" and permanently opted the lead out. Trimming only a leading
 * or trailing run of ASCII whitespace/punctuation avoids that: any message
 * with real content on either side, in any script, is left untouched and
 * therefore never equals the bare keyword.
 */
function bareWord(text: string): string {
  return text.replace(/^[\s.,!?;:'"()-]+|[\s.,!?;:'"()-]+$/g, '')
}

function matches(text: string, keyword: string): boolean {
  if (WHOLE_MESSAGE_ONLY.has(keyword)) return bareWord(text) === bareWord(keyword)
  // Digit-aware boundaries: `\b` would let `q1` match inside "q12".
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(keyword)}(?![a-z0-9])`).test(text)
}

/**
 * Opt-out wins over snooze — it is the stronger, safer signal, and a message
 * can carry both ("stop messaging me, call me next year"). Within each list,
 * the first match in §6.2's own order is the one reported.
 */
export function detectKeywords(body: string, sentAt: Date): KeywordDetection {
  const text = normalize(body)

  for (const keyword of OPT_OUT_KEYWORDS) {
    if (matches(text, keyword)) {
      return { opted_out: true, snooze_until: null, keyword_hit: keyword }
    }
  }

  for (const keyword of SNOOZE_KEYWORDS) {
    if (matches(text, keyword)) {
      const days = keyword === 'next year' ? SNOOZE_DAYS_NEXT_YEAR : SNOOZE_DAYS_DEFAULT
      return {
        opted_out: false,
        snooze_until: new Date(sentAt.getTime() + days * MS_PER_DAY).toISOString(),
        keyword_hit: keyword,
      }
    }
  }

  return { opted_out: false, snooze_until: null, keyword_hit: null }
}
