# Task 7 — `packages/llm/src/call.ts` + `MockProvider`

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 7:

> `packages/llm/src/call.ts` with usage logging + cost table. `MockProvider` in core.

**Outcome:** the single chokepoint every LLM call in the repo goes through, and the messaging seam's only implementation. Nothing calls a prompt yet — this is the plumbing tasks 9 and 11 will use.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| The three prompts (`extract.ts`, `write.ts`, `toneCheck.ts`) | Tasks 9 and 11 |
| Any actual LLM request against the real API | Task 9 (`extract-facts`) |
| `0004_approve_draft.sql` — unblocked by this task | After this, before task 13 |
| Edge functions of any kind | Task 9 onward |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

---

## Read this before you start

### Six traps

**Trap 1 — `MockProvider.send()` does NOT write to the database.**
§1 describes the mock as "writes to `messages` with `direction='outbound'`", and that sentence is the single most misleading line in this task. `CLAUDE.md` amendment **A1** already settled where that write happens: `approve_draft` (migration `0004`) performs the insert inside its transaction and generates the `provider_msg_id` inline, *because plpgsql cannot call TypeScript*. On top of that, `packages/core` has zero dependencies and does no I/O — a `send()` that opened a database connection would break both A1 and contract rule 3. `send()` mints an id and returns. That's the whole job.

**Trap 2 — use the official SDK, not `fetch`.**
`@anthropic-ai/sdk@0.115.0` is already a dependency of `packages/llm` (installed at task 1). Use it. Hand-rolling HTTP against the Messages API is the wrong call when the SDK is already there — and mixing the two is worse. See trap 6 for the one real consequence this has downstream.

**Trap 3 — the model is `claude-sonnet-4-6`, and it is not the newest model.**
§2 fixes it: `claude-sonnet-4-6` for all three stages, temperature **0.3 extract / 0.7 write / 0 tone**. Do not "upgrade" the model string. This matters more than it looks: `temperature` is **accepted on Sonnet 4.6 but removed on Opus 4.7+ and Sonnet 5**, where sending it is a 400. So the contract's temperature settings and its model choice are a matched pair — changing one silently breaks the other.

**Trap 4 — an unpriced model must throw, not cost `0`.**
The cost table is keyed by model string. If a model isn't in it, `costUsd` throws. The tempting alternative — return `0` for an unknown model — makes the trace panel (§9) and `eval_runs.cost_usd` (§10) silently report free LLM calls, which is worse than a crash because nobody notices.

**Trap 5 — every stage returns JSON, so parse failures are the normal error path.**
All three prompts (§7.1–7.3) say *"Output ONLY a JSON object. No prose, no markdown fences."* Models mostly comply and occasionally don't. `call()` strips a markdown fence if one appears and throws a stage-named error if the body still isn't JSON. A generic `JSON.parse` failure three layers down is unactionable at 2am.

Note for whoever types this out: `call.ts` and `call.test.ts` both contain literal triple-backtick sequences (the fence-stripping regex, and the tests for it). Their code blocks below are therefore fenced with **four** backticks. Copy what's between the four-backtick markers — the triple backticks are part of the source.

**Trap 6 — this code has to run in Deno as well as Node.**
Edge functions (task 9+) are Deno; the eval harness (task 12) and these tests are Node. Two consequences, both handled in the code below:
- Read `ANTHROPIC_API_KEY` through a runtime check (`Deno.env.get` then `process.env`) rather than assuming `process`.
- A Deno edge function importing `@anthropic-ai/sdk` by bare specifier needs an import map (`supabase/functions/deno.json` mapping it to `npm:@anthropic-ai/sdk@0.115.0`). That's task 9's step, but it exists *because* of the choice made here — note it now so it isn't a surprise.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.

---

## Step 1 — `packages/llm/src/call.ts`

Create the file with exactly this content.

````ts
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
````


Three decisions worth knowing, all deliberate:

- **Usage is logged before the JSON parse.** A call that returned prose still burned tokens. Logging after the parse would make exactly the failures you most want to see disappear from the record.
- **`console.log` is the sink.** // SPEC-GAP: rule 4 says call.ts "logs" the usage record but §3 defines no `llm_calls` table, so there is nowhere to persist it. Structured stdout is the simplest thing that satisfies the rule; the `log` dep exists so a caller can redirect it. `generate-drafts` (task 11) puts the same numbers in `drafts.trace` where the UI reads them.
- **No `thinking` parameter.** Sonnet 4.6 supports adaptive thinking but leaves it off unless asked, and §2 doesn't ask. Off is cheaper, faster, and deterministic for three short structured-output stages.

### Verify

```bash
cd $REPO
grep -c "claude-sonnet-4-6" packages/llm/src/call.ts   # 1 — the cost table entry
grep -c "SPEC-GAP" packages/llm/src/call.ts            # 2 — MessagesClient, log sink
grep -c "globalThis" packages/llm/src/call.ts          # 3 — readEnv's doc comment + 2 in its body
```

Expected: `1`, `2`, `3`.

The last one is trap 6 in assertion form. Note it is *not* `grep -c "process.env"` — that returns `0`, because the runtime is reached as `(globalThis as {...}).process` and indexed as `proc?.env[name]`. The literal string `process.env` never appears, and it must not: a bare `process.env.ANTHROPIC_API_KEY` is exactly the line that would throw `ReferenceError: process is not defined` the first time an edge function runs this in Deno at task 9.

---

## Step 2 — `packages/llm/src/call.test.ts`

Create the file with exactly this content. No network, no API key.

````ts
import { describe, expect, it, vi } from 'vitest'
import { call, costUsd, extractJson } from './call'
import type { LlmUsage, MessagesClient } from './call'

function fakeClient(text: string, input = 1000, output = 500): MessagesClient {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: input, output_tokens: output },
      }),
    },
  }
}

describe('costUsd', () => {
  it('prices claude-sonnet-4-6 at $3 / $15 per million tokens', () => {
    expect(costUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18.0, 10)
    expect(costUsd('claude-sonnet-4-6', 1200, 300)).toBeCloseTo(0.0081, 10)
  })

  it('throws on an unpriced model rather than reporting $0 (trap 4)', () => {
    expect(() => costUsd('claude-opus-5', 100, 100)).toThrow(/No cost entry/)
  })
})

describe('extractJson', () => {
  it('passes bare JSON through untouched', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
  })

  it('strips a fence the prompt explicitly told the model not to emit', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
})

describe('call', () => {
  it('returns parsed JSON and the exact usage shape rule 4 specifies', async () => {
    let clock = 1000
    const logged: LlmUsage[] = []

    const result = await call<{ verdict: string }>(
      {
        stage: 'tone',
        model: 'claude-sonnet-4-6',
        prompt_version: 'tone-v1',
        system: 'sys',
        user: 'usr',
        max_tokens: 512,
        temperature: 0,
      },
      {
        client: fakeClient('{"verdict":"pass"}'),
        now: () => (clock += 640) - 640,
        log: (u) => logged.push(u),
      },
    )

    expect(result.parsed.verdict).toBe('pass')
    expect(Object.keys(result.usage).sort()).toEqual([
      'cost_usd',
      'input_tokens',
      'latency_ms',
      'model',
      'output_tokens',
      'prompt_version',
      'stage',
    ])
    expect(logged).toHaveLength(1)
    expect(logged[0]!.stage).toBe('tone')
    expect(logged[0]!.latency_ms).toBe(640)
  })

  it('names the stage and prompt version when the model returns prose', async () => {
    await expect(
      call(
        {
          stage: 'write',
          model: 'claude-sonnet-4-6',
          prompt_version: 'write-v1',
          system: 's',
          user: 'u',
          max_tokens: 1024,
          temperature: 0.7,
        },
        { client: fakeClient('Sure! Here you go.'), log: () => {} },
      ),
    ).rejects.toThrow(/write \(write-v1\) did not return JSON/)
  })

  it('still logs usage for a call whose output failed to parse', async () => {
    const logged: LlmUsage[] = []
    await call(
      {
        stage: 'write',
        model: 'claude-sonnet-4-6',
        prompt_version: 'write-v1',
        system: 's',
        user: 'u',
        max_tokens: 1024,
        temperature: 0.7,
      },
      { client: fakeClient('not json'), log: (u) => logged.push(u) },
    ).catch(() => {})
    // The request cost money whether or not the body parsed.
    expect(logged).toHaveLength(1)
    expect(logged[0]!.cost_usd).toBeGreaterThan(0)
  })

  it('passes model, temperature and max_tokens through unchanged (trap 3)', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }))

    await call(
      {
        stage: 'extract',
        model: 'claude-sonnet-4-6',
        prompt_version: 'extract-v1',
        system: 's',
        user: 'u',
        max_tokens: 4096,
        temperature: 0.3,
      },
      { client: { messages: { create } } as unknown as MessagesClient, log: () => {} },
    )

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        temperature: 0.3,
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'u' }],
      }),
    )
  })
})
````

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -6
```

Green. This file adds **8 tests**.

---

## Step 3 — `packages/llm/src/index.ts`

Replace the stub with:

```ts
export * from './call'
```

Task 9 adds `./prompts/extract`, task 11 adds `./prompts/write` and `./prompts/toneCheck`.

---

## Step 4 — `packages/core/src/mockProvider.ts`

**Re-read trap 1 first.** Create the file with exactly this content:

```ts
import type { InboundMessage, MessagingProvider } from './types'

/**
 * The only `MessagingProvider` implementation this build ships (§1).
 *
 * // SPEC-GAP: §1 says "Implement MockProvider only" but its file list for
 * packages/core names only classify / selectStrategy / guardrail / facts /
 * sg-rules / types. It lives in its own file rather than types.ts, which
 * task 3 deliberately kept types-only.
 *
 * `send()` performs NO I/O. §1 describes the mock as "writes to `messages`
 * with direction='outbound'", but CLAUDE.md amendment A1 already settled
 * where that write happens: `approve_draft` (migration 0004) does the insert
 * inside its transaction and generates the provider_msg_id inline, precisely
 * because plpgsql cannot call TypeScript. packages/core also has zero
 * dependencies and does no I/O (contract rule 3) — a send() that opened a
 * database connection would break both. Minting an id is the whole job.
 */
export class MockProvider implements MessagingProvider {
  readonly name = 'mock' as const

  /** Injected so tests are deterministic; defaults to a real UUID. */
  constructor(private readonly newId: () => string = () => `mock-${crypto.randomUUID()}`) {}

  send(_to: string, _body: string): Promise<{ providerMsgId: string }> {
    return Promise.resolve({ providerMsgId: this.newId() })
  }

  /**
   * // SPEC-GAP: no webhook payload shape is specified anywhere in the
   * contract — there is no real provider to define one. This accepts the
   * shape MockProvider itself would emit and rejects anything else loudly,
   * rather than returning [] and looking like "no messages arrived".
   */
  parseWebhook(payload: unknown): InboundMessage[] {
    if (typeof payload !== 'object' || payload === null || !('messages' in payload)) {
      throw new Error('MockProvider.parseWebhook: expected { messages: [...] }.')
    }
    const { messages } = payload as { messages: unknown }
    if (!Array.isArray(messages)) {
      throw new Error('MockProvider.parseWebhook: `messages` must be an array.')
    }
    return messages.map((m, i) => {
      if (typeof m !== 'object' || m === null) {
        throw new Error(`MockProvider.parseWebhook: messages[${i}] is not an object.`)
      }
      const { from, body, sent_at, provider_msg_id } = m as Record<string, unknown>
      for (const [key, value] of Object.entries({ from, body, sent_at, provider_msg_id })) {
        if (typeof value !== 'string') {
          throw new Error(`MockProvider.parseWebhook: messages[${i}].${key} must be a string.`)
        }
      }
      return { from, body, sent_at, provider_msg_id } as InboundMessage
    })
  }
}
```

`crypto.randomUUID()` typechecks here because task 4 added `"types": ["node"]` to `packages/core/tsconfig.json`; it also exists natively in Deno, so this file runs unchanged in an edge function.

---

## Step 5 — `packages/core/src/mockProvider.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from './mockProvider'

describe('MockProvider', () => {
  it('satisfies the MessagingProvider seam', () => {
    expect(new MockProvider().name).toBe('mock')
  })

  it('send() mints an id and does no I/O (trap 1)', async () => {
    let n = 0
    const provider = new MockProvider(() => `id-${++n}`)
    expect(await provider.send('+6580000000', 'hi')).toEqual({ providerMsgId: 'id-1' })
    expect(await provider.send('+6580000000', 'hi')).toEqual({ providerMsgId: 'id-2' })
  })

  it('ids are unique with the real default generator', async () => {
    const provider = new MockProvider()
    const a = await provider.send('+6580000000', 'x')
    const b = await provider.send('+6580000000', 'x')
    expect(a.providerMsgId).not.toBe(b.providerMsgId)
  })

  it('parseWebhook parses a well-formed payload', () => {
    const payload = {
      messages: [
        {
          from: '+6580000000',
          body: 'hi',
          sent_at: '2026-07-30T00:00:00Z',
          provider_msg_id: 'm1',
        },
      ],
    }
    expect(new MockProvider().parseWebhook(payload)).toEqual(payload.messages)
  })

  it('parseWebhook throws instead of silently returning []', () => {
    const provider = new MockProvider()
    expect(() => provider.parseWebhook({})).toThrow(/expected \{ messages/)
    expect(() => provider.parseWebhook({ messages: 'nope' })).toThrow(/must be an array/)
    expect(() => provider.parseWebhook({ messages: [{ from: 1 }] })).toThrow(
      /messages\[0\]\.from must be a string/,
    )
  })
})
```

Add the barrel export in `$REPO/packages/core/src/index.ts`:

```ts
export * from './types'
export * from './sg-rules'
export * from './facts'
export * from './classify'
export * from './selectStrategy'
export * from './guardrail'
export * from './mockProvider'
```

---

## Step 6 — Full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0. `pnpm test` should report **7 test files** — the five from tasks 3–6 plus `mockProvider` (core) and `call` (llm) — and **126 tests** (113 + 5 + 8). Treat the counts as informational.

**`packages/llm` needs no tsconfig change.** It has no `"types": ["node"]` and doesn't need one: `readEnv` reaches `process` through `globalThis` rather than importing Node types, and the SDK ships its own. If you find yourself adding `@types/node` here, check why first.

**Do not try a `node --input-type=module` one-liner.** Both new files have runtime imports (the SDK; `./types`), and Node's ESM loader won't resolve extensionless specifiers — same limitation as tasks 5 and 6. Vitest already runs this code.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `ANTHROPIC_API_KEY is not set` during `pnpm test` | A test hit the real client path | Every test must pass `deps.client` — check the failing test |
| `No cost entry for model "..."` | Model string doesn't match the table key | Trap 3 — the model is `claude-sonnet-4-6`; don't upgrade it |
| `Cannot find name 'crypto'` in `mockProvider.ts` | `packages/core/tsconfig.json` lost `"types": ["node"]` | Task 4 added it; restore it |
| `Cannot find module '@anthropic-ai/sdk'` | Dependency not linked | `pnpm install` from the repo root |
| `Property 'messages' is missing` on the client cast | The `as unknown as MessagesClient` cast was removed | The SDK's type is wider than the slice we use; the cast is load-bearing |
| A 400 mentioning `temperature` (later, at task 9) | Model was changed to Opus 4.7+ / Sonnet 5 | Those models removed sampling params — trap 3 |

---

## Step 7 — Acceptance and commit

### Checklist

- [ ] `costUsd` throws for an unpriced model; `claude-sonnet-4-6` is the only entry, at $3 / $15
- [ ] `call()` logs the exact rule-4 key set — `stage`, `model`, `prompt_version`, `input_tokens`, `output_tokens`, `latency_ms`, `cost_usd`
- [ ] Usage is logged even when the response fails to parse, with a test proving it
- [ ] `MockProvider.send()` performs no I/O and takes an injectable id generator
- [ ] `parseWebhook` throws on a malformed payload rather than returning `[]`
- [ ] Every test runs without an API key and without network
- [ ] `packages/llm` has no `@types/node` and no tsconfig change
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all exit 0
- [ ] No prompt files, no edge functions, no `0004_approve_draft.sql` — those are tasks 9, 11, and next

### Expected tree

```
$REPO/packages/
├── core/src/
│   ├── mockProvider.ts        # new
│   ├── mockProvider.test.ts   # new
│   └── index.ts               # edited: +./mockProvider
└── llm/src/
    ├── call.ts                # new
    ├── call.test.ts           # new
    └── index.ts               # edited: export * from './call'
```

Nothing under `supabase/`, `apps/`, or `packages/eval` changes.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 7: LLM call wrapper + MockProvider"
```

Then update **Current state** in `CLAUDE.md` to task 7 complete, and note that `0004_approve_draft.sql` (amendment A1) is now unblocked.

---

## Next

**`0004_approve_draft.sql` comes before task 8.** Amendment A1 parked it until `MockProvider` existed; it does now. §8 specifies it: quiet hours check (SGT hour within `[quiet_hours_start, quiet_hours_end)`, 409 `outside_quiet_hours` if not), the mock send, the outbound `messages` insert, and `touch_count += 1` / `last_outbound_at` / `resolved_at` / `status` — all in one transaction, which is the entire reason it isn't a client-side `PATCH`. Note the shape A1 settled: the plpgsql function generates the `provider_msg_id` itself; `MockProvider` is the TypeScript-side seam used by edge functions and eval, not something SQL calls.

Then task 8 — `seed/seed.ts`: 2 agents (the second with a contrasting voice profile, so task 12's two-voice fixture has something real to run against), 6 leads under the first agent across states (cold-with-gap, cold-complete, new-ad, warm-already-messaged, opted-out, dormant), ~40 messages in the fixture voice.

Two things to know for task 8:

- **`db.seed.enabled` is `false`** (amendment A3) — `seed.ts` is a script you run, not something `supabase db reset` picks up. Wire it as a `package.json` script.
- **Seeding uses the service role**, which bypasses RLS. That's expected and is exactly why task 2's RLS verification used the anon key instead.
