import { MAX_DRAFT_CHARS } from '../../../core/src/sg-rules.ts'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'tone-v1'

export const system = `You are a strict reviewer. Judge one drafted WhatsApp message from a Singapore
property agent to a lead.

Output ONLY: {"verdict":"pass"|"fail","reasons":[".."]}

Fail if ANY of:
- Pushy, guilt-inducing, or manufacturing urgency
- Claims or implies eligibility, approval, returns, or appreciation
- References a specific price, district, project, date, or unit type NOT in FACTS
- Reads as a mass template rather than a message to this person
- Longer than ${MAX_DRAFT_CHARS} characters, or formatted like an email
- Apologetic or servile in tone

Be strict. A false fail costs one draft. A false pass costs the agent's
reputation and possibly their WhatsApp number.`

export interface ToneCheckInput {
  facts: { key: string; value: unknown }[]
  draft: string
}

export interface ToneVerdict {
  verdict: 'pass' | 'fail'
  reasons: string[]
}

/** §7.3's USER block. */
export function buildUser(input: ToneCheckInput): string {
  const factLines = input.facts.length
    ? input.facts.map((f) => `${f.key}: ${JSON.stringify(f.value)}`).join('\n')
    : '(none)'
  return `FACTS: ${factLines}\nDRAFT: ${input.draft}`
}
