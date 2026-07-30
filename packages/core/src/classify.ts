import type { LeadRow, LeadState } from './types.ts'

const MS_PER_DAY = 86_400_000

/**
 * Whole days elapsed from `then` to `now`, floored.
 *
 * // SPEC-GAP: §6.1 calls diffDays twice but never defines it. Floored whole
 * days is derived, not invented: §6.1's own fallthrough note says a `new`
 * lead "becomes cold via the classify() fall-through on day 3", which only
 * holds if 2.9 days floors to 2 (still `new`, since the test is `<= 2`) and
 * 3.0 floors to 3. §8's trace agrees — `"days_since_inbound": 21` is an
 * integer. A fractional diffDays would flip that lead at exactly 2.0 days
 * and contradict both.
 *
 * Exported because task 5 needs the same arithmetic for `days_since_outbound`
 * and `days_silent` (§6.3). §1's file list has no `time.ts`, so it lives here
 * rather than in a new module the contract doesn't name.
 *
 * Accepts a string because row timestamps arrive as ISO strings from
 * PostgREST (see the header of `types.ts`); accepts a Date for callers that
 * already have one. Returns a negative number if `then` is in the future —
 * that is left to fall through the normal branches rather than clamped,
 * since a future timestamp means bad data, and `warm` is the safe reading
 * (the AI stays out of it).
 */
export function diffDays(now: Date, then: string | Date): number {
  const thenMs = then instanceof Date ? then.getTime() : new Date(then).getTime()
  return Math.floor((now.getTime() - thenMs) / MS_PER_DAY)
}

/**
 * The only thing in the system that decides a lead's state (§6.1).
 *
 * Pure: no clock, no I/O. `now` is injected so the eval harness (task 12) can
 * test time-dependent behaviour without mocking `Date` — contract rule 3.
 *
 * Note there is no timezone handling here and none is needed: this measures
 * elapsed time between two instants. SGT only matters for quiet hours, which
 * run in `approve_draft` (§8).
 */
export function classify(lead: LeadRow, now: Date): LeadState {
  if (lead.opted_out) return 'do_not_contact';
  if (lead.qualification_status === 'handed_off') return 'handed_off';
  if (lead.qualification_status === 'disqualified') return 'do_not_contact';

  const daysSinceInbound = lead.last_inbound_at
    ? diffDays(now, lead.last_inbound_at) : null;
  const daysSinceCreated = diffDays(now, lead.created_at);

  if (lead.touch_count === 0 && daysSinceInbound === null && daysSinceCreated <= 2)
    return 'new';
  if (daysSinceInbound !== null && daysSinceInbound <= 7)  return 'warm';
  if (daysSinceInbound !== null && daysSinceInbound <= 45)  return 'cold';
  if (daysSinceInbound !== null)                            return 'dormant';
  return daysSinceCreated <= 45 ? 'cold' : 'dormant';
}
