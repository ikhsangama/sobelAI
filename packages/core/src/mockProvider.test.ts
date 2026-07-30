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
