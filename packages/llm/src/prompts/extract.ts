import { AREA_ALIASES } from '../../../core/src/sg-rules.ts'
import { FACT_KEYS } from '../../../core/src/facts.ts'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'extract-v1'

export const system = `You extract structured facts from WhatsApp conversations between a Singapore
property agent and a lead. You are a transcriber, not an analyst.

Rules:
- Output ONLY a JSON object. No prose, no markdown fences.
- Shape: {"facts":[{"key":..,"value":..,"confidence":0-1,
           "source_message_index":<int>,"evidence":"<verbatim substring>"}]}
- \`evidence\` MUST be an exact substring copied character-for-character from the
  message at \`source_message_index\`. Never paraphrase it. Never reconstruct it.
- If you cannot point to a verbatim span, OMIT the fact entirely. An omitted
  fact is always better than an inferred one.
- Do not infer. "I stay in Tampines" describes where the lead currently
  lives, not a district they want to buy in — do not emit a \`districts\` fact
  from it. "Maybe around 1m" is budget_max=1000000 with confidence 0.6, not
  1.0.
- Only these keys: ${FACT_KEYS.join(', ')}
- Budgets: convert to plain SGD integers. "1.2m"=1200000, "800k"=800000.
  "under 1m" => budget_max only. "1 to 1.2m" => budget_min and budget_max.
- Districts: return the DXX code. Map colloquial names using: ${JSON.stringify(AREA_ALIASES)}
  If a location is ambiguous, omit it.
- The conversation may be in Singlish or mixed English/Chinese. Handle both.
- If the lead contradicts an earlier statement, extract only the MOST RECENT value.`

export interface PromptMessage {
  direction: 'inbound' | 'outbound'
  body: string
}

/**
 * §7.1's user block: "Messages (index: direction: body):" then the numbered
 * list. The index is what the model puts in `source_message_index`, so it
 * must match the array position in the same list `validateFacts` is given.
 */
export function buildUser(messages: PromptMessage[]): string {
  const lines = messages.map((m, i) => `${i}: ${m.direction}: ${m.body}`)
  return `Messages (index: direction: body):\n${lines.join('\n')}`
}
