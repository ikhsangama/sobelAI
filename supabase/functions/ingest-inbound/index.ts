import { createClient } from '@supabase/supabase-js'
import { detectKeywords } from '../../../packages/core/src/keywords.ts'

/**
 * POST /functions/v1/ingest-inbound  (§8)
 *   req: { "agent_id": "uuid", "lead_id": "uuid", "body": "string", "sent_at": "ISO?" }
 *   res: { message_id, opt_out_detected, snooze_until, keyword_hit, facts_refreshed }
 *
 * §8: "Inserts message, runs opt-out/snooze detection, sets
 * last_inbound_at = sent_at, resets touch_count = 0, then calls extract-facts."
 *
 * Deliberately does NOT write `leads.state` — §6.1 makes generate-drafts the
 * only writer of that column anywhere in the system, and task 4 ships a test
 * that fails if anything else touches it.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://kong:8000'
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  let agent_id: string
  let lead_id: string
  let body: string
  let sentAt: Date
  try {
    const payload = await req.json()
    agent_id = payload.agent_id
    lead_id = payload.lead_id
    body = payload.body
    if (typeof agent_id !== 'string' || !agent_id) throw new Error('agent_id is required')
    if (typeof lead_id !== 'string' || !lead_id) throw new Error('lead_id is required')
    if (typeof body !== 'string' || !body.trim()) throw new Error('body is required')
    sentAt = payload.sent_at ? new Date(payload.sent_at) : new Date()
    if (Number.isNaN(sentAt.getTime())) throw new Error('sent_at is not a valid date')
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400)
  }

  // Confirm the lead exists and belongs to the claimed agent before writing.
  const { data: lead, error: leadErr } = await db
    .from('leads')
    .select('id, agent_id')
    .eq('id', lead_id)
    .single()
  if (leadErr || !lead) return json({ error: `lead not found: ${lead_id}` }, 404)
  if (lead.agent_id !== agent_id) {
    return json({ error: `lead ${lead_id} does not belong to agent ${agent_id}` }, 403)
  }

  const sentAtIso = sentAt.toISOString()

  const { data: message, error: msgErr } = await db
    .from('messages')
    .insert({
      lead_id,
      agent_id,
      direction: 'inbound',
      body,
      sent_at: sentAtIso,
      provider: 'mock',
    })
    .select('id')
    .single()
  if (msgErr || !message) {
    return json({ error: `inserting message failed: ${msgErr?.message}` }, 500)
  }

  // §6.2, deterministic and no LLM. sentAt is injected (trap 2).
  const detection = detectKeywords(body, sentAt)

  // §8: last_inbound_at and touch_count always reset on any inbound.
  // snooze_until follows the same rule, on the same reasoning: an inbound
  // that isn't itself a new snooze request means the lead is back, so a
  // stale snooze from an earlier message must not keep suppressing them.
  // detection.snooze_until is already null on every non-snooze inbound
  // (including opt-out, which detectKeywords never pairs with a snooze), so
  // assigning it unconditionally both sets and clears correctly.
  // `state` is intentionally absent — trap 3.
  const leadUpdate: Record<string, unknown> = {
    last_inbound_at: sentAtIso,
    touch_count: 0,
    snooze_until: detection.snooze_until,
  }
  if (detection.opted_out) leadUpdate.opted_out = true

  const { error: updateErr } = await db.from('leads').update(leadUpdate).eq('id', lead_id)
  if (updateErr) return json({ error: `updating lead failed: ${updateErr.message}` }, 500)

  // §6.2: "Log which keyword fired into the trace." There is no trace object
  // on this path (drafts.trace belongs to generate-drafts), so structured
  // stdout is the sink, same SPEC-GAP resolution as call.ts's usage logging.
  if (detection.keyword_hit) {
    console.log(
      JSON.stringify({
        ingest_inbound: {
          lead_id,
          message_id: message.id,
          keyword_hit: detection.keyword_hit,
          opted_out: detection.opted_out,
          snooze_until: detection.snooze_until,
        },
      }),
    )
  }

  // §8: "then calls extract-facts". Trap 6 — internal URL, service-role auth.
  //
  // SPEC-GAP: §8 doesn't say what happens when extraction fails. The message
  // is already recorded and the lead already updated, so failing the whole
  // request would misreport work that did happen. Report facts_refreshed: 0
  // and log; the caller can retry extraction independently.
  let facts_refreshed = 0
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ lead_id }),
    })
    if (res.ok) {
      const extracted = await res.json()
      facts_refreshed = extracted.inserted ?? 0
    } else {
      console.error(
        JSON.stringify({ extract_facts_failed: { lead_id, status: res.status } }),
      )
    }
  } catch (err) {
    console.error(
      JSON.stringify({ extract_facts_failed: { lead_id, error: (err as Error).message } }),
    )
  }

  return json({
    message_id: message.id,
    opt_out_detected: detection.opted_out,
    snooze_until: detection.snooze_until,
    keyword_hit: detection.keyword_hit,
    facts_refreshed,
  })
})
