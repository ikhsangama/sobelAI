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
  // §2's model, and the documented default. Anthropic published pricing.
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  // Dev-only alternative provider — see `resolveProvider()`. DeepSeek
  // published pricing, cache-miss input rate. These exist so a local run on
  // DeepSeek still reports a real cost_usd in the trace rather than throwing;
  // they do not make DeepSeek the shipped default.
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
}

export type LlmProvider = 'anthropic' | 'deepseek'

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6', // §2
  deepseek: 'deepseek-v4-pro',
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * // SPEC-GAP: §2 names `claude-sonnet-4-6` and `ANTHROPIC_API_KEY`, and that
 * remains the default with no env set. `LLM_PROVIDER=deepseek` is a local
 * development escape hatch for running the pipeline when Anthropic credits
 * aren't available — it is deliberately opt-in so the shipped behaviour still
 * matches the contract. If a run is ever demoed on DeepSeek, say so in the
 * README alongside the React 19 departure.
 */
export function resolveProvider(): LlmProvider {
  const raw = (readEnv('LLM_PROVIDER') ?? 'anthropic').toLowerCase()
  if (raw !== 'anthropic' && raw !== 'deepseek') {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "deepseek", got "${raw}".`)
  }
  return raw
}

/** §2's model unless overridden. `LLM_MODEL` wins over the provider default. */
export function resolveModel(): string {
  return readEnv('LLM_MODEL') ?? DEFAULT_MODEL[resolveProvider()]
}

/**
 * DeepSeek speaks the OpenAI chat-completions shape, so this adapter is the
 * single point where the two wire formats differ: the system prompt becomes a
 * message rather than a top-level field, and `prompt_tokens`/`completion_tokens`
 * map onto `input_tokens`/`output_tokens`. Everything downstream in `call()` —
 * usage logging, the cost table, fence stripping, the stage-named parse error
 * — is provider-agnostic and untouched.
 *
 * `fetchImpl` is injectable so the translation can be unit-tested without a
 * network call or a key, the same reason `CallDeps.client` exists.
 */
export function createDeepSeekClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): MessagesClient {
  return {
    messages: {
      async create(params) {
        const res = await fetchImpl(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            max_tokens: params.max_tokens,
            temperature: params.temperature,
            messages: [{ role: 'system', content: params.system }, ...params.messages],
            stream: false,
          }),
        })
        if (!res.ok) {
          // Same `<status> <body>` shape the Anthropic SDK error produces, so
          // the callers' error strings read identically across providers.
          throw new Error(`${res.status} ${await res.text()}`)
        }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        return {
          content: [{ type: 'text', text: body.choices?.[0]?.message?.content ?? '' }],
          usage: {
            input_tokens: body.usage?.prompt_tokens ?? 0,
            output_tokens: body.usage?.completion_tokens ?? 0,
          },
        }
      },
    },
  }
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
    if (resolveProvider() === 'deepseek') {
      const apiKey = readEnv('DEEPSEEK_API_KEY')
      if (!apiKey) {
        throw new Error(
          'DEEPSEEK_API_KEY is not set, but LLM_PROVIDER=deepseek. It is ' +
            'server-side only — it belongs in the edge function environment, ' +
            'never in anything VITE_ prefixed.',
        )
      }
      defaultClient = createDeepSeekClient(apiKey)
    } else {
      const apiKey = readEnv('ANTHROPIC_API_KEY')
      if (!apiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is not set. It is server-side only (§2) — it belongs ' +
            'in the edge function environment, never in anything VITE_ prefixed.',
        )
      }
      defaultClient = new Anthropic({ apiKey }) as unknown as MessagesClient
    }
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

  const usageBase = {
    stage: params.stage,
    model: params.model,
    prompt_version: params.prompt_version,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    latency_ms,
  }

  // costUsd() is computed in its own try/catch, not inline in the object
  // literal below: the request already happened and already cost money by
  // this point, so an unpriced model must not cost the record its log line
  // too. NaN is the sentinel for "spent, amount unknown" — never silently 0.
  let cost_usd: number
  try {
    cost_usd = costUsd(params.model, response.usage.input_tokens, response.usage.output_tokens)
  } catch (err) {
    log({ ...usageBase, cost_usd: NaN })
    throw err
  }

  const usage: LlmUsage = { ...usageBase, cost_usd }

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
