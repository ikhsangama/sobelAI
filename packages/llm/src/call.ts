import Anthropic from '@anthropic-ai/sdk'

/**
 * The one place an LLM request is made (contract rule 4). Every call logs
 * `{stage, model, prompt_version, input_tokens, output_tokens, latency_ms,
 * cost_usd}`. No direct SDK calls anywhere else in the repo — the cost and
 * latency numbers in the trace panel (§9) and in `eval_runs` (§10) are only
 * trustworthy if this is the sole entry point.
 */
export type LlmStage = 'extract' | 'write' | 'tone'

export interface LlmUsage {
  stage: LlmStage
  model: string
  prompt_version: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
  cost_usd: number
}

export interface LlmCallResult<T> {
  raw: string
  parsed: T
  usage: LlmUsage
}

/**
 * USD per 1,000,000 tokens, per Anthropic's published pricing.
 *
 * Only the model §2 pins is listed. Adding a model here is a deliberate act:
 * an entry with guessed numbers is worse than no entry, because `costUsd`
 * throws loudly on a missing model but reports a confident wrong figure for
 * a wrong one.
 */
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
}

/**
 * The slice of the SDK client this module actually uses.
 *
 * // SPEC-GAP: the contract says every call goes through this file but says
 * nothing about testability. A structural interface lets the tests inject a
 * fake without a network call or an API key, and the real `Anthropic` client
 * satisfies it.
 */
export interface MessagesResponse {
  content: Array<{ type: string; text?: string }>
  usage: { input_tokens: number; output_tokens: number }
}

export interface MessagesClient {
  messages: {
    create(params: {
      model: string
      max_tokens: number
      system: string
      temperature: number
      messages: Array<{ role: 'user'; content: string }>
    }): Promise<MessagesResponse>
  }
}

export interface CallParams {
  stage: LlmStage
  model: string
  /** Written to `eval_runs.prompt_version` (§10); bump it on every prompt edit. */
  prompt_version: string
  system: string
  user: string
  max_tokens: number
  temperature: number
}

export interface CallDeps {
  client?: MessagesClient
  now?: () => number
  log?: (usage: LlmUsage) => void
}

/**
 * `ANTHROPIC_API_KEY` from whichever runtime we're in — Deno for edge
 * functions (task 9+), Node for the eval harness (task 12) and tests.
 * Checking `globalThis` avoids needing Deno's types in this package.
 */
function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno
  if (deno) return deno.env.get(name)
  const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
  return proc?.env[name]
}

let defaultClient: MessagesClient | undefined

/** Lazy so importing this module never requires a key — tests inject instead. */
function getDefaultClient(): MessagesClient {
  if (!defaultClient) {
    const apiKey = readEnv('ANTHROPIC_API_KEY')
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. It is server-side only (§2) — it belongs ' +
          'in the edge function environment, never in anything VITE_ prefixed.',
      )
    }
    defaultClient = new Anthropic({ apiKey }) as unknown as MessagesClient
  }
  return defaultClient
}

/** Trap 4: an unpriced model throws rather than silently reporting $0. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_MTOK[model]
  if (!rate) {
    throw new Error(
      `No cost entry for model "${model}". Add it to COST_PER_MTOK in call.ts — ` +
        'reporting 0 would make the trace panel and eval_runs understate spend.',
    )
  }
  return (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output
}

/**
 * Trap 5: all three prompts forbid markdown fences, but a model occasionally
 * emits one anyway. Strip it rather than fail a request over formatting.
 */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  return (fenced?.[1] ?? raw).trim()
}

export async function call<T>(
  params: CallParams,
  deps: CallDeps = {},
): Promise<LlmCallResult<T>> {
  const client = deps.client ?? getDefaultClient()
  const now = deps.now ?? (() => Date.now())
  // SPEC-GAP: rule 4 requires this record be logged, but §3 defines no
  // `llm_calls` table — there is nowhere to persist it. Structured stdout is
  // the simplest sink that satisfies the rule, and `deps.log` lets a caller
  // redirect it. generate-drafts (task 11) puts the same numbers into
  // `drafts.trace`, which is where the UI actually reads them.
  const log = deps.log ?? ((u: LlmUsage) => console.log(JSON.stringify({ llm_call: u })))

  const started = now()
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system,
    temperature: params.temperature,
    messages: [{ role: 'user', content: params.user }],
  })
  const latency_ms = now() - started

  const raw = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')

  const usage: LlmUsage = {
    stage: params.stage,
    model: params.model,
    prompt_version: params.prompt_version,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    latency_ms,
    cost_usd: costUsd(params.model, response.usage.input_tokens, response.usage.output_tokens),
  }

  // Logged before parsing: a call that produced unparseable output still cost
  // real money and still belongs in the usage record.
  log(usage)

  let parsed: T
  const json = extractJson(raw)
  try {
    parsed = JSON.parse(json) as T
  } catch {
    throw new Error(
      `${params.stage} (${params.prompt_version}) did not return JSON. ` +
        `Got: ${raw.slice(0, 200)}`,
    )
  }

  return { raw, parsed, usage }
}
