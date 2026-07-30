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
      const value = item.value
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
      value: item.value,
      confidence: item.confidence,
      source_message_index: item.source_message_index,
      evidence: item.evidence,
    })
  }

  return { accepted, rejections }
}
