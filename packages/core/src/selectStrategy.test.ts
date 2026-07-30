import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRow, LeadRow } from './types'
import { DEFAULT_STRATEGY_RULES, selectStrategy } from './selectStrategy'
import type { StrategyRule } from './selectStrategy'

const NOW = new Date('2026-07-30T10:00:00+08:00')

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString()
}

function daysAfter(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString()
}

const AGENT: AgentRow = {
  id: 'agent-id',
  name: 'Wei Ling',
  voice_profile: {
    formality: 2, warmth: 4, brevity: 4,
    sample_messages: [], sign_off: '', emoji_ok: false,
  },
  quiet_hours_start: 9,
  quiet_hours_end: 20,
  max_touches: 4,
  created_at: daysBefore(365),
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

/**
 * State builders. classify() derives state from timestamps, so these produce
 * leads that genuinely land in the state their name claims — verified by the
 * `state` field every assertion below also checks.
 */
const newLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: null, touch_count: 0, created_at: daysBefore(1), ...o })

const warmLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(2), created_at: daysBefore(60), ...o })

/** cold, and silent for 20 days — long enough for listing_hook's `>= 14`. */
const coldSilentLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(20), created_at: daysBefore(60), ...o })

/** cold, but only 10 days silent — below listing_hook's threshold. */
const coldRecentLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(10), created_at: daysBefore(60), ...o })

const dormantLead = (o: Partial<LeadRow> = {}) =>
  lead({ last_inbound_at: daysBefore(90), created_at: daysBefore(120), ...o })

function run(l: LeadRow, factGaps: string[] = [], rules: StrategyRule[] = DEFAULT_STRATEGY_RULES) {
  return selectStrategy({ lead: l, agent: AGENT, rules, factGaps, now: NOW })
}

const ALL_GAPS = ['transaction_type', 'budget_max', 'districts', 'timeline']

describe('selectStrategy — every rule fires when expected', () => {
  it('hard_suppress (100) on an opted-out lead', () => {
    const r = run(coldSilentLead({ opted_out: true }), ALL_GAPS)
    expect(r.state).toBe('do_not_contact')
    expect(r.rule_fired).toBe('hard_suppress')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBe(100)
  })

  it('hard_suppress (100) on a handed-off lead', () => {
    const r = run(coldSilentLead({ qualification_status: 'handed_off' }), ALL_GAPS)
    expect(r.rule_fired).toBe('hard_suppress')
  })

  it('snoozed (95) while snooze_until is in the future', () => {
    const r = run(coldSilentLead({ snooze_until: daysAfter(20) }), ALL_GAPS)
    expect(r.rule_fired).toBe('snoozed')
    expect(r.strategy).toBe('suppress')
  })

  it('touch_cap (90) at the agent max', () => {
    const r = run(coldSilentLead({ touch_count: 4 }), ALL_GAPS)
    expect(r.rule_fired).toBe('touch_cap')
  })

  it('warm_human_handles (80) once the AI has messaged and the lead replied', () => {
    const r = run(warmLead({ touch_count: 1 }))
    expect(r.state).toBe('warm')
    expect(r.rule_fired).toBe('warm_human_handles')
    expect(r.strategy).toBe('suppress')
  })

  it('new_ad_lead (75) on an untouched meta_ad lead', () => {
    const r = run(newLead({ source: 'meta_ad' }))
    expect(r.state).toBe('new')
    expect(r.rule_fired).toBe('new_ad_lead')
    expect(r.strategy).toBe('instant_qualify')
  })

  it('last_chance (70) at max_touches - 1', () => {
    const r = run(coldSilentLead({ touch_count: 3 }), ALL_GAPS)
    expect(r.rule_fired).toBe('last_chance')
    expect(r.strategy).toBe('final_nudge')
  })

  it('gap_fill (60) when facts are missing', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
    expect(r.strategy).toBe('fill_missing_fact')
  })

  it('listing_hook (50) when facts are complete and silence >= 14 days', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), [])
    expect(r.rule_fired).toBe('listing_hook')
    expect(r.strategy).toBe('new_listing_hook')
  })

  it('gentle_check_in (40) when cold, complete, and silent under 14 days', () => {
    const r = run(coldRecentLead({ touch_count: 1 }), [])
    expect(r.state).toBe('cold')
    expect(r.rule_fired).toBe('gentle_check_in')
    expect(r.strategy).toBe('soft_check_in')
  })

  it('long_dormant (30) on a dormant lead', () => {
    const r = run(dormantLead({ touch_count: 1 }), [])
    expect(r.state).toBe('dormant')
    expect(r.rule_fired).toBe('long_dormant')
    expect(r.strategy).toBe('market_update')
  })
})

describe('selectStrategy — lower-priority rules lose when outranked', () => {
  it('hard_suppress beats snoozed', () => {
    expect(run(coldSilentLead({ opted_out: true, snooze_until: daysAfter(20) }), ALL_GAPS)
      .rule_fired).toBe('hard_suppress')
  })

  it('snoozed beats touch_cap', () => {
    expect(run(coldSilentLead({ snooze_until: daysAfter(20), touch_count: 4 }), ALL_GAPS)
      .rule_fired).toBe('snoozed')
  })

  it('touch_cap beats last_chance', () => {
    // touch_count 4 satisfies `>= max_touches`; only 3 would be last_chance.
    expect(run(coldSilentLead({ touch_count: 4 }), ALL_GAPS).rule_fired).toBe('touch_cap')
  })

  it('last_chance beats gap_fill', () => {
    expect(run(coldSilentLead({ touch_count: 3 }), ALL_GAPS).rule_fired).toBe('last_chance')
  })

  it('gap_fill beats listing_hook', () => {
    // 20 days silent would satisfy listing_hook, but gaps exist.
    expect(run(coldSilentLead({ touch_count: 1 }), ['timeline']).rule_fired).toBe('gap_fill')
  })

  it('gap_fill beats gentle_check_in', () => {
    expect(run(coldRecentLead({ touch_count: 1 }), ['timeline']).rule_fired).toBe('gap_fill')
  })

  it('listing_hook beats gentle_check_in', () => {
    expect(run(coldSilentLead({ touch_count: 1 }), []).rule_fired).toBe('listing_hook')
  })

  it('records every enabled rule in rules_evaluated, winner included', () => {
    const r = run(coldSilentLead({ touch_count: 1 }), ['timeline'])
    expect(r.rules_evaluated).toHaveLength(10)
    expect(r.rules_evaluated.find((e) => e.name === 'gap_fill')?.matched).toBe(true)
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('skips disabled rules entirely', () => {
    const withoutGapFill = DEFAULT_STRATEGY_RULES.map((r) =>
      r.name === 'gap_fill' ? { ...r, enabled: false } : r,
    )
    const r = run(coldRecentLead({ touch_count: 1 }), ['timeline'], withoutGapFill)
    expect(r.rule_fired).toBe('gentle_check_in')
    expect(r.rules_evaluated).toHaveLength(9)
  })
})

describe('selectStrategy — the Meta ad lead (§11)', () => {
  it('a zero-touch new + meta_ad lead reaches instant_qualify', () => {
    const r = run(newLead({ source: 'meta_ad' }))
    expect(r.rule_fired).toBe('new_ad_lead')
    expect(r.strategy).toBe('instant_qualify')
    // warm_human_handles must not have swallowed it.
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('warm_human_handles stands down for a zero-touch lead that just replied', () => {
    const r = run(warmLead({ source: 'meta_ad', touch_count: 0 }))
    expect(r.state).toBe('warm')
    expect(r.rules_evaluated.find((e) => e.name === 'warm_human_handles')?.matched).toBe(false)
  })

  it('DOCUMENTED GAP: a meta_ad lead who submitted the form matches no rule', () => {
    // Submitting the ad form IS an inbound message, so classify() returns
    // `warm`, not `new`. warm_human_handles correctly stands down
    // (touch_count is 0), but new_ad_lead requires state == 'new' — so
    // nothing matches and the lead gets no first contact.
    //
    // This pins the CURRENT behaviour of §6.3 as literally specified. It is
    // not an endorsement: it is a question for the founder (see README).
    // Do not "fix" the rule table to make this test go green — contract
    // rule 1 forbids inventing business logic.
    const r = run(lead({
      source: 'meta_ad',
      touch_count: 0,
      last_inbound_at: daysBefore(0),
      created_at: daysBefore(0),
    }))
    expect(r.state).toBe('warm')
    expect(r.rule_fired).toBe('no_rule_matched')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBeNull()
  })
})

describe('selectStrategy — post-selection cooldown (trap 2)', () => {
  it('suppresses when the winner is inside its cooldown, naming the blocked rule', () => {
    // gap_fill has cooldown_days 5; last outbound was 2 days ago.
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(2) }), ['timeline'])
    expect(r.rule_fired).toBe('cooldown_active')
    expect(r.strategy).toBe('suppress')
    expect(r.suppressed_by_cooldown).toBe('gap_fill')
    expect(r.rule_priority).toBeNull()
  })

  it('allows the rule once the cooldown has elapsed', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(6) }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
    expect(r.suppressed_by_cooldown).toBeUndefined()
  })

  it('treats the cooldown boundary as inclusive (days == cooldown_days fires)', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: daysBefore(5) }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
  })

  it('never cools down a lead that has never been messaged', () => {
    const r = run(coldSilentLead({ touch_count: 1, last_outbound_at: null }), ['timeline'])
    expect(r.rule_fired).toBe('gap_fill')
  })

  it('does not cooldown-suppress a zero-cooldown suppression rule', () => {
    // hard_suppress has cooldown_days 0, so `days < 0` is never true.
    const r = run(coldSilentLead({ opted_out: true, last_outbound_at: daysBefore(0) }), ALL_GAPS)
    expect(r.rule_fired).toBe('hard_suppress')
  })
})

describe('selectStrategy — no rule matches', () => {
  it('returns suppress with no_rule_matched and a null priority', () => {
    // A `new` non-ad lead: §6.1's documented two-day cold start.
    const r = run(newLead({ source: 'propertyguru' }))
    expect(r.state).toBe('new')
    expect(r.rule_fired).toBe('no_rule_matched')
    expect(r.strategy).toBe('suppress')
    expect(r.rule_priority).toBeNull()
  })
})

describe('selectStrategy — malformed rules fail loudly (trap 5)', () => {
  it('throws on an unknown match key rather than matching everything', () => {
    const typo = [{ ...DEFAULT_STRATEGY_RULES[0]!, match: { state_id: ['cold'] } }]
    expect(() => run(coldSilentLead(), [], typo)).toThrow(/unknown key "state_id"/)
  })

  it('throws on an unknown numeric operator', () => {
    const bad = [{ ...DEFAULT_STRATEGY_RULES[0]!, match: { touch_count: { above: 2 } } }]
    expect(() => run(coldSilentLead(), [], bad)).toThrow(/unknown operator "above"/)
  })

  it('throws when two enabled rules share a priority', () => {
    const tied = [
      { ...DEFAULT_STRATEGY_RULES[0]! },
      { ...DEFAULT_STRATEGY_RULES[1]!, priority: 100 },
    ]
    expect(() => run(coldSilentLead(), [], tied)).toThrow(/priority 100 is used by both/)
  })
})

describe('the migration and DEFAULT_STRATEGY_RULES cannot drift', () => {
  it('0003_strategy_rules.sql seeds exactly the canonical rules', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '0003_strategy_rules.sql'),
      'utf8',
    )

    // One `('<name>', <priority>, '<strategy>', <cooldown>, <enabled>,` per row.
    const rows = [...sql.matchAll(
      /\('(\w+)',\s*(\d+),\s*'([\w_]+)',\s*(\d+),\s*(true|false),/g,
    )].map((m) => ({
      name: m[1], priority: Number(m[2]), strategy: m[3],
      cooldown_days: Number(m[4]), enabled: m[5] === 'true',
    }))

    expect(rows).toHaveLength(DEFAULT_STRATEGY_RULES.length)
    for (const expected of DEFAULT_STRATEGY_RULES) {
      expect(rows).toContainEqual({
        name: expected.name,
        priority: expected.priority,
        strategy: expected.strategy,
        cooldown_days: expected.cooldown_days,
        enabled: expected.enabled,
      })
    }
  })

  it('does not seed cooldown_active as a row (trap 1)', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '0003_strategy_rules.sql'),
      'utf8',
    )
    expect(sql).not.toMatch(/\('cooldown_active'/)
    expect(sql).not.toMatch(/\('no_rule_matched'/)
  })
})
