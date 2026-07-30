import { MAX_DRAFT_CHARS } from '../../../core/src/sg-rules.ts'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'write-v1'

export const system = `You draft a single WhatsApp follow-up message that a Singapore property agent
will read and approve before it is sent. You are ghostwriting as the agent.

Hard constraints:
- Output ONLY a JSON object: {"message":..,"facts_referenced":[..],"confidence":0-1}
- ONE message. Under ${MAX_DRAFT_CHARS} characters. WhatsApp register: short lines,
  no subject line, no letter formatting, no signature block.
- You may ONLY reference facts present in FACTS below. Do not mention any
  price, district, date, project name, or unit type that is not there.
- Never invent listings, viewings, appointments, or market statistics.
- Never state that the lead is eligible for anything, will qualify for
  anything, or that a property will appreciate. If eligibility is relevant,
  ASK about it with a question mark.
- No pressure tactics, no false scarcity, no guarantees.
- Do not apologise for following up. Do not say "just checking in" verbatim.
- Write in the agent's voice per VOICE below.

Strategy definitions — follow the one given exactly:
- soft_check_in: light, low-obligation re-open. Reference something specific
  from the earlier conversation. Give them an easy out.
- new_listing_hook: mention that something matching their stated criteria has
  come up. Describe it ONLY using their own stated criteria — no invented
  address, price, or project name. End with a yes/no question.
- fill_missing_fact: ask for exactly ONE missing detail: <GAP>. Explain in one
  clause why it helps you help them.
- instant_qualify: first contact from an ad. Introduce the agent by name, note
  where the enquiry came from, ask at most TWO qualifying questions.
- market_update: long-dormant. Offer general, non-numeric context about their
  area of interest and ask if their plans have changed.
- final_nudge: last message before going quiet. Say plainly that you will stop
  following up, and leave the door open. No guilt, no urgency.`

export interface VoiceProfile {
  formality: number
  warmth: number
  brevity: number
  emoji_ok: boolean
  sign_off: string
  sample_messages: string[]
}

export interface WritePromptInput {
  agentName: string
  voice: VoiceProfile
  strategy: string
  /** The single fact key to ask for, when strategy is fill_missing_fact. */
  gap: string | null
  /** `key: value` pairs — the ONLY facts the model may reference. */
  facts: { key: string; value: unknown }[]
  /** Oldest-first; §7.2 asks for the last 6. */
  messages: { direction: 'inbound' | 'outbound'; body: string }[]
  daysSinceLastReply: number | null
}

/** §7.2's USER block, in the order the contract writes it. */
export function buildUser(input: WritePromptInput): string {
  const { agentName, voice, strategy, gap, facts, messages, daysSinceLastReply } = input

  const factLines = facts.length
    ? facts.map((f) => `${f.key}: ${JSON.stringify(f.value)}`).join('\n')
    : '(none)'

  const samples = voice.sample_messages.slice(0, 3)
  const sampleLines = samples.length ? samples.map((s) => `- ${s}`).join('\n') : '(none)'

  const messageLines = messages.length
    ? messages.map((m, i) => `${i}: ${m.direction}: ${m.body}`).join('\n')
    : '(none)'

  return [
    `AGENT NAME: ${agentName}`,
    `VOICE: formality ${voice.formality}/5, warmth ${voice.warmth}/5, brevity ${voice.brevity}/5, emoji ${voice.emoji_ok ? 'ok' : 'no'},`,
    `       sign-off: "${voice.sign_off}"`,
    `SAMPLE MESSAGES BY THIS AGENT (match the rhythm, not the content):`,
    sampleLines,
    `STRATEGY: ${strategy}`,
    `GAP TO FILL (if any): ${gap ?? '(none)'}`,
    `FACTS (the ONLY facts you may reference):`,
    factLines,
    `LAST 6 MESSAGES:`,
    messageLines,
    `DAYS SINCE LEAD LAST REPLIED: ${daysSinceLastReply ?? '(never replied)'}`,
  ].join('\n')
}
