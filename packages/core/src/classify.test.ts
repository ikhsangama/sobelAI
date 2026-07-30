import { describe, expect, it } from 'vitest'
import type { LeadRow } from './types'
import { classify, diffDays } from './classify'

/** Fixed clock. Every case is expressed as an offset from this instant. */
const NOW = new Date('2026-07-30T10:00:00+08:00')

/** ISO timestamp for exactly `days` before NOW. Fractions allowed. */
function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString()
}

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-id',
    agent_id: 'agent-id',
    name: 'Marcus',
    phone: '+6580000000',
    source: 'propertyguru',
    state: 'new',
    qualification_status: 'unqualified',
    last_inbound_at: null,
    last_outbound_at: null,
    touch_count: 0,
    snooze_until: null,
    opted_out: false,
    created_at: daysBefore(0),
    ...overrides,
  }
}

describe('diffDays', () => {
  it('returns whole days for an exact multiple', () => {
    expect(diffDays(NOW, daysBefore(7))).toBe(7)
  })

  it('floors a partial day rather than rounding', () => {
    expect(diffDays(NOW, daysBefore(7.9))).toBe(7)
  })

  it('ticks over only once the full day has elapsed', () => {
    expect(diffDays(NOW, daysBefore(8))).toBe(8)
  })

  it('returns 0 for the same instant', () => {
    expect(diffDays(NOW, daysBefore(0))).toBe(0)
  })

  it('returns a negative number for a future timestamp', () => {
    expect(diffDays(NOW, daysBefore(-3))).toBe(-3)
  })
})

describe('classify — short circuits', () => {
  it('opted_out wins over everything else', () => {
    // Inbound yesterday would otherwise read as `warm`.
    expect(classify(lead({ opted_out: true, last_inbound_at: daysBefore(1) }), NOW))
      .toBe('do_not_contact')
  })

  it('handed_off maps to its own state', () => {
    expect(classify(lead({ qualification_status: 'handed_off' }), NOW))
      .toBe('handed_off')
  })

  it('disqualified maps to do_not_contact, not to a state of the same name', () => {
    expect(classify(lead({ qualification_status: 'disqualified' }), NOW))
      .toBe('do_not_contact')
  })

  it('opted_out is checked before qualification_status', () => {
    expect(classify(
      lead({ opted_out: true, qualification_status: 'handed_off' }),
      NOW,
    )).toBe('do_not_contact')
  })
})

describe('classify — the `new` window (boundary at 2 days)', () => {
  it('is new on the day it was created', () => {
    expect(classify(lead({ created_at: daysBefore(0) }), NOW)).toBe('new')
  })

  it('is still new at exactly 2 days', () => {
    expect(classify(lead({ created_at: daysBefore(2) }), NOW)).toBe('new')
  })

  it('falls through to cold on day 3', () => {
    // §6.1's documented cold-start: a non-ad lead gets no rule for two days,
    // then becomes cold and starts receiving gentle_check_in.
    expect(classify(lead({ created_at: daysBefore(3) }), NOW)).toBe('cold')
  })

  it('is not new once the agent has touched it', () => {
    expect(classify(lead({ created_at: daysBefore(1), touch_count: 1 }), NOW))
      .toBe('cold')
  })

  it('is not new once the lead has replied', () => {
    expect(classify(
      lead({ created_at: daysBefore(1), last_inbound_at: daysBefore(1) }),
      NOW,
    )).toBe('warm')
  })
})

describe('classify — warm/cold boundary at 7 days', () => {
  it('is warm when the lead replied today', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(0), touch_count: 1 }), NOW))
      .toBe('warm')
  })

  it('is still warm at exactly 7 days', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(7), touch_count: 1 }), NOW))
      .toBe('warm')
  })

  it('turns cold at 8 days', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(8), touch_count: 1 }), NOW))
      .toBe('cold')
  })
})

describe('classify — cold/dormant boundary at 45 days', () => {
  it('is still cold at exactly 45 days', () => {
    expect(classify(
      lead({ last_inbound_at: daysBefore(45), created_at: daysBefore(60), touch_count: 1 }),
      NOW,
    )).toBe('cold')
  })

  it('turns dormant at 46 days', () => {
    expect(classify(
      lead({ last_inbound_at: daysBefore(46), created_at: daysBefore(60), touch_count: 1 }),
      NOW,
    )).toBe('dormant')
  })
})

describe('classify — null-inbound fallthrough (a lead that never replied)', () => {
  it('is cold at exactly 45 days since creation', () => {
    expect(classify(
      lead({ last_inbound_at: null, created_at: daysBefore(45), touch_count: 1 }),
      NOW,
    )).toBe('cold')
  })

  it('is dormant at 46 days since creation', () => {
    expect(classify(
      lead({ last_inbound_at: null, created_at: daysBefore(46), touch_count: 1 }),
      NOW,
    )).toBe('dormant')
  })
})
