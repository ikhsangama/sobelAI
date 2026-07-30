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
