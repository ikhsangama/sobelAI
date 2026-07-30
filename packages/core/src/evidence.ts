import type { Fact } from './types.ts'
import { FACT_KEYS } from './facts.ts'
import { normalizeNumbers } from './guardrail.ts'

/**
 * Layers 2 and 3 of §5's evidence rule, as a pure function.
 *
 * // SPEC-GAP: §1's file list for packages/core doesn't name this file. It
 * lives here rather than inside the edge function because §5 calls the
 * evidence rule "the single most important correctness property in the repo"
 * and contract rule 3 wants that kind of logic unit-tested without a network
 * or a database. `extract-facts` orchestrates; this decides.
 *
 * Layer 1 is the prompt (§7.1). Layer 4 is the test file next to this one.
 * Superseding is a database concern and stays in the edge function.
 */

export type RejectionReason =
  | 'unknown_key'
  | 'bad_shape'
  | 'bad_message_index'
  | 'evidence_mismatch'
  | 'value_evidence_mismatch'

export interface RawFact {
  key: string
  value: unknown
  confidence: number
  source_message_index: number
  evidence: string
}

export interface AcceptedFact {
  key: Fact['key']
  value: unknown
  confidence: number
  source_message_index: number
  evidence: string
}

export interface Rejection {
  key: string
  reason: RejectionReason
  evidence: string
}

export interface ValidationResult {
  accepted: AcceptedFact[]
  rejections: Rejection[]
}

/**
 * §5 layer 3 applies to these three keys only — the ones whose value is a
 * bare number the model could misread out of a real span.
 */
export const NUMERIC_CROSS_CHECK_KEYS = ['budget_min', 'budget_max', 'bedrooms'] as const

/** §5: "within ±2% of the emitted value", to allow "1.2m" ↔ 1200000. */
const TOLERANCE = 0.02

/**
 * §5's FACT_KEYS declares exactly one array-valued key: `districts // string[]`.
 * Every other key is a scalar.
 */
const ARRAY_VALUED_KEYS: ReadonlySet<string> = new Set(['districts'])

/**
 * // SPEC-GAP: §7.1 tells the model "Districts: return the DXX code" without
 * saying whether that is a string or an array, so it returns either —
 * nondeterministically, across leads in the same run. Measured on a real
 * extraction: Priya and Siti came back as `["D19"]`/`["D18"]`, while Marcus,
 * Rachel and Kelvin came back as bare `"D15"`/`"D03"`/`"D16"`.
 *
 * That inconsistency is not cosmetic. `guardrail.ts`'s `factValues()` only
 * collects districts when `Array.isArray(f.value)`, so a string-valued fact is
 * invisible to G3 — and every district in an otherwise truthful draft is then
 * flagged as invented. Observed live: Rachel's draft correctly said "D03",
 * D03 was correctly extracted from "queenstown showflat", and G3 still failed
 * it with "district D03 is not in the fact set". It fails closed, so nothing
 * hallucinated slips through, but it rejects honest drafts. It would also
 * break §10's F01, which asserts `districts` deep-equals `["D15"]`.
 *
 * Normalising here rather than in the prompt: §11 freezes the prompts at task
 * 11, and §5 already makes this file the place where the server, not the
 * model, decides what is allowed into `lead_facts`. Coercion is safe because
 * it changes the container, never the content — the DXX code the model
 * extracted is preserved exactly, and layers 2 and 3 still run against it.
 */
function normalizeArrayValued(value: unknown): string[] | null {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
  if (!list || list.length === 0) return null
  return list.every((v) => typeof v === 'string') ? (list as string[]) : null
}

function isRawFact(x: unknown): x is RawFact {
  if (typeof x !== 'object' || x === null) return false
  const f = x as Record<string, unknown>
  return (
    typeof f.key === 'string' &&
    'value' in f &&
    typeof f.confidence === 'number' &&
    Number.isFinite(f.confidence) &&
    f.confidence >= 0 &&
    f.confidence <= 1 &&
    typeof f.source_message_index === 'number' &&
    Number.isInteger(f.source_message_index) &&
    typeof f.evidence === 'string' &&
    f.evidence.trim().length > 0
  )
}

/**
 * Run the model's raw output through layers 2 and 3.
 *
 * `messages` must be the same array, in the same order, that was numbered
 * into the prompt — `source_message_index` indexes into it.
 */
export function validateFacts(raw: unknown, messages: { body: string }[]): ValidationResult {
  const accepted: AcceptedFact[] = []
  const rejections: Rejection[] = []

  const list = Array.isArray(raw) ? raw : []

  for (const item of list) {
    if (!isRawFact(item)) {
      const key =
        typeof (item as { key?: unknown })?.key === 'string' ? (item as RawFact).key : '(unparseable)'
      const evidence =
        typeof (item as { evidence?: unknown })?.evidence === 'string' ? (item as RawFact).evidence : ''
      rejections.push({ key, reason: 'bad_shape', evidence })
      continue
    }

    if (!(FACT_KEYS as readonly string[]).includes(item.key)) {
      rejections.push({ key: item.key, reason: 'unknown_key', evidence: item.evidence })
      continue
    }

    // Coerce §5's one array-valued key into its declared shape, so a
    // string-valued `districts` can't slip past G3's Array.isArray() check.
    let value = item.value
    if (ARRAY_VALUED_KEYS.has(item.key)) {
      const normalized = normalizeArrayValued(value)
      if (!normalized) {
        rejections.push({ key: item.key, reason: 'bad_shape', evidence: item.evidence })
        continue
      }
      value = normalized
    }

    const message = messages[item.source_message_index]
    if (!message) {
      rejections.push({ key: item.key, reason: 'bad_message_index', evidence: item.evidence })
      continue
    }

    // Layer 2 — verbatim substring of the cited message.
    if (!message.body.toLowerCase().includes(item.evidence.toLowerCase())) {
      rejections.push({ key: item.key, reason: 'evidence_mismatch', evidence: item.evidence })
      continue
    }

    // Layer 3 — the number in the span must be the number that was emitted.
    if ((NUMERIC_CROSS_CHECK_KEYS as readonly string[]).includes(item.key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        rejections.push({ key: item.key, reason: 'value_evidence_mismatch', evidence: item.evidence })
        continue
      }
      const found = normalizeNumbers(item.evidence)
      const withinTolerance = found.some((n) => Math.abs(n - value) <= Math.abs(value) * TOLERANCE)
      if (!withinTolerance) {
        rejections.push({ key: item.key, reason: 'value_evidence_mismatch', evidence: item.evidence })
        continue
      }
    }

    accepted.push({
      key: item.key as Fact['key'],
      value,
      confidence: item.confidence,
      source_message_index: item.source_message_index,
      evidence: item.evidence,
    })
  }

  return { accepted, rejections }
}
