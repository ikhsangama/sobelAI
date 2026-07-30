import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, costUsd, createDeepSeekClient, extractJson, resolveModel, resolveProvider } from './call'
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

  it('prices the dev-only DeepSeek models from their published rates', () => {
    // deepseek-v4-pro: $0.435 in / $0.87 out per 1M (cache-miss input rate).
    expect(costUsd('deepseek-v4-pro', 1_000_000, 1_000_000)).toBeCloseTo(1.305, 10)
    // deepseek-v4-flash: $0.14 in / $0.28 out per 1M.
    expect(costUsd('deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.42, 10)
  })
})

describe('provider selection — §2 stays the default', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('defaults to anthropic and §2s model with no env set', () => {
    delete process.env.LLM_PROVIDER
    delete process.env.LLM_MODEL
    expect(resolveProvider()).toBe('anthropic')
    expect(resolveModel()).toBe('claude-sonnet-4-6')
  })

  it('switches to deepseek only when explicitly opted in', () => {
    process.env.LLM_PROVIDER = 'deepseek'
    delete process.env.LLM_MODEL
    expect(resolveProvider()).toBe('deepseek')
    expect(resolveModel()).toBe('deepseek-v4-pro')
  })

  it('lets LLM_MODEL win over the provider default', () => {
    process.env.LLM_PROVIDER = 'deepseek'
    process.env.LLM_MODEL = 'deepseek-v4-flash'
    expect(resolveModel()).toBe('deepseek-v4-flash')
  })

  it('throws on an unrecognised provider rather than silently using anthropic', () => {
    process.env.LLM_PROVIDER = 'openai'
    expect(() => resolveProvider()).toThrow(/must be "anthropic" or "deepseek"/)
  })
})

describe('createDeepSeekClient — wire-format translation', () => {
  function stubFetch(body: unknown, ok = true, status = 200) {
    return vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        ({
          ok,
          status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        }) as unknown as Response,
    )
  }

  const okBody = {
    choices: [{ message: { content: '{"verdict":"pass"}' } }],
    usage: { prompt_tokens: 120, completion_tokens: 34 },
  }

  it('moves the system prompt into the messages array (OpenAI shape)', async () => {
    const f = stubFetch(okBody)
    await createDeepSeekClient('sk-test', f).messages.create({
      model: 'deepseek-v4-pro',
      max_tokens: 512,
      system: 'SYS',
      temperature: 0.3,
      messages: [{ role: 'user', content: 'USR' }],
    })
    const sent = JSON.parse(String(f.mock.calls[0]![1]!.body))
    expect(sent.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' },
    ])
    expect(sent.model).toBe('deepseek-v4-pro')
    expect(sent.temperature).toBe(0.3)
    expect(sent.max_tokens).toBe(512)
  })

  it('maps prompt/completion tokens onto the Anthropic-shaped usage fields', async () => {
    const r = await createDeepSeekClient('sk-test', stubFetch(okBody)).messages.create({
      model: 'deepseek-v4-pro',
      max_tokens: 512,
      system: 's',
      temperature: 0,
      messages: [{ role: 'user', content: 'u' }],
    })
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 34 })
    expect(r.content).toEqual([{ type: 'text', text: '{"verdict":"pass"}' }])
  })

  it('is a drop-in for MessagesClient, so call() works unchanged over it', async () => {
    const logged: LlmUsage[] = []
    const result = await call<{ verdict: string }>(
      {
        stage: 'tone',
        model: 'deepseek-v4-pro',
        prompt_version: 'tone-v1',
        system: 's',
        user: 'u',
        max_tokens: 512,
        temperature: 0,
      },
      { client: createDeepSeekClient('sk-test', stubFetch(okBody)), log: (u) => logged.push(u) },
    )
    expect(result.parsed.verdict).toBe('pass')
    expect(logged[0]!.input_tokens).toBe(120)
    // Cost comes from the same table, so the trace stays comparable.
    expect(logged[0]!.cost_usd).toBeCloseTo((120 / 1e6) * 0.435 + (34 / 1e6) * 0.87, 12)
  })

  it('throws `<status> <body>` on a non-2xx, matching the Anthropic error shape', async () => {
    const f = stubFetch({ error: { message: 'nope' } }, false, 402)
    await expect(
      createDeepSeekClient('sk-test', f).messages.create({
        model: 'deepseek-v4-pro',
        max_tokens: 8,
        system: 's',
        temperature: 0,
        messages: [{ role: 'user', content: 'u' }],
      }),
    ).rejects.toThrow(/^402 /)
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

  it('still logs a usage record when the model is unpriced, instead of dropping it', async () => {
    // The request below actually "happens" (against a fake client) and burns
    // 500/200 tokens before costUsd() ever runs. Losing the log line here
    // would be worse than the parse-failure case above: real spend with zero
    // trace of it.
    const logged: LlmUsage[] = []
    await expect(
      call(
        {
          stage: 'write',
          model: 'claude-opus-5',
          prompt_version: 'write-v1',
          system: 's',
          user: 'u',
          max_tokens: 1024,
          temperature: 0.7,
        },
        { client: fakeClient('{"ok":true}', 500, 200), log: (u) => logged.push(u) },
      ),
    ).rejects.toThrow(/No cost entry/)

    expect(logged).toHaveLength(1)
    expect(logged[0]!.input_tokens).toBe(500)
    expect(logged[0]!.output_tokens).toBe(200)
    expect(logged[0]!.cost_usd).toBeNaN()
  })

  it('throws with a clear message when no client is injected and the API key is unset', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(
        call(
          {
            stage: 'extract',
            model: 'claude-sonnet-4-6',
            prompt_version: 'extract-v1',
            system: 's',
            user: 'u',
            max_tokens: 100,
            temperature: 0.3,
          },
          {},
        ),
      ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/)
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })
})
