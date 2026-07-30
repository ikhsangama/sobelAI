import { describe, expect, it } from 'vitest'
import type { Fact } from './types'
import { factGaps } from './facts'

function fact(key: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-id',
    lead_id: 'lead-id',
    agent_id: 'agent-id',
    key,
    value: 'placeholder',
    confidence: 0.9,
    source_message_id: 'message-id',
    evidence: 'placeholder evidence',
    extracted_at: '2026-07-30T00:00:00Z',
    superseded_at: null,
    ...overrides,
  }
}

describe('factGaps', () => {
  it('reports all four required keys when no facts exist', () => {
    expect(factGaps([])).toEqual([
      'transaction_type',
      'budget_max',
      'districts',
      'timeline',
    ])
  })

  it('reports no gaps once all four required facts are present', () => {
    const facts = [
      fact('budget_max'),
      fact('districts'),
      fact('timeline'),
      fact('transaction_type'),
    ]
    expect(factGaps(facts)).toEqual([])
  })

  it('does not count a superseded fact as present', () => {
    const facts = [
      fact('budget_max'),
      fact('districts'),
      fact('transaction_type'),
      fact('timeline', { superseded_at: '2026-07-01T00:00:00Z' }),
    ]
    expect(factGaps(facts)).toContain('timeline')
  })
})
