import { createClient } from '@supabase/supabase-js'
import { validateFacts } from '../../../packages/core/src/evidence.ts'
import { call } from '../../../packages/llm/src/call.ts'
import { buildUser, system, version } from '../../../packages/llm/src/prompts/extract.ts'

/**
 * POST /functions/v1/extract-facts  (§8)
 *   req: { "lead_id": "uuid", "force": false }
 *   res: { lead_id, inserted, superseded, rejected, rejections[], facts[], usage{} }
 *
 * The four-layer evidence rule (§5): layer 1 is the prompt, layers 2 and 3 are
 * `validateFacts` in packages/core, layer 4 is evidence.test.ts. This file adds
 * the database half — superseding — and never inserts a fact the validator
 * didn't accept.
 */

const MODEL = 'claude-sonnet-4-6'
const TEMPERATURE = 0.3 // §2, for the extract stage
const MAX_TOKENS = 4096
const MESSAGE_WINDOW = 20 // §7.1: "last 20"

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? 'http://kong:8000',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Deep-equal for jsonb fact values — arrays and scalars only, no cycles. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

Deno.serve(async (req) => {
  let lead_id: string
  let force = false
  try {
    const body = await req.json()
    lead_id = body.lead_id
    force = body.force === true
    if (typeof lead_id !== 'string' || !lead_id) throw new Error('lead_id is required')
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400)
  }

  const { data: lead, error: leadErr } = await db
    .from('leads')
    .select('id, agent_id')
    .eq('id', lead_id)
    .single()
  if (leadErr || !lead) return json({ error: `lead not found: ${lead_id}` }, 404)

  // §7.1's window is the most recent 20, oldest-first so index 0 is stable.
  const { data: recent, error: msgErr } = await db
    .from('messages')
    .select('id, direction, body, sent_at')
    .eq('lead_id', lead_id)
    .order('sent_at', { ascending: false })
    .limit(MESSAGE_WINDOW)
  if (msgErr) return json({ error: `loading messages failed: ${msgErr.message}` }, 500)

  const messages = (recent ?? []).slice().reverse()

  // Trap 5 — an empty thread is a real state (the seeded Meta ad lead), not an
  // error, and it must not cost an LLM call to discover.
  if (messages.length === 0) {
    return json({
      lead_id,
      inserted: 0,
      superseded: 0,
      rejected: 0,
      rejections: [],
      facts: [],
      usage: { latency_ms: 0, cost_usd: 0, prompt_version: version },
    })
  }

  const { data: existing, error: existErr } = await db
    .from('lead_facts')
    .select('id, key, value')
    .eq('lead_id', lead_id)
    .is('superseded_at', null)
  if (existErr) return json({ error: `loading facts failed: ${existErr.message}` }, 500)

  // SPEC-GAP: §8 documents `force` but not what it forces. Cheapest useful
  // reading: without it, skip the LLM call when nothing has arrived since the
  // last extraction. Re-running `pnpm eval` or a cadence tick then costs $0
  // instead of re-paying for an identical answer.
  if (!force && (existing?.length ?? 0) > 0) {
    const { data: lastRun } = await db
      .from('lead_facts')
      .select('extracted_at')
      .eq('lead_id', lead_id)
      .order('extracted_at', { ascending: false })
      .limit(1)
    const lastExtractedAt = lastRun?.[0]?.extracted_at
    const newestMessageAt = messages[messages.length - 1]!.sent_at
    if (lastExtractedAt && newestMessageAt <= lastExtractedAt) {
      return json({
        lead_id,
        inserted: 0,
        superseded: 0,
        rejected: 0,
        rejections: [],
        facts: existing ?? [],
        usage: { latency_ms: 0, cost_usd: 0, prompt_version: version },
      })
    }
  }

  let parsed: { facts?: unknown }
  let usage
  try {
    const result = await call<{ facts?: unknown }>({
      stage: 'extract',
      model: MODEL,
      prompt_version: version,
      system,
      user: buildUser(messages),
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    })
    parsed = result.parsed
    usage = result.usage
  } catch (err) {
    return json({ error: `extraction failed: ${(err as Error).message}` }, 502)
  }

  // Layers 2 and 3. `messages` here is the exact array numbered into the
  // prompt, so source_message_index lines up.
  const { accepted, rejections } = validateFacts(parsed.facts, messages)

  let inserted = 0
  let superseded = 0

  for (const f of accepted) {
    const prior = (existing ?? []).find((e) => e.key === f.key)

    // Unchanged value — nothing to record. Inserting a duplicate would grow
    // the history with rows that say nothing happened.
    if (prior && sameValue(prior.value, f.value)) continue

    // Trap 6 — supersede, never UPDATE.
    if (prior) {
      const { error } = await db
        .from('lead_facts')
        .update({ superseded_at: new Date().toISOString() })
        .eq('id', prior.id)
      if (error) return json({ error: `superseding ${f.key} failed: ${error.message}` }, 500)
      superseded++
    }

    const { error } = await db.from('lead_facts').insert({
      lead_id,
      agent_id: lead.agent_id,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      source_message_id: messages[f.source_message_index]!.id,
      evidence: f.evidence,
    })
    if (error) return json({ error: `inserting ${f.key} failed: ${error.message}` }, 500)
    inserted++
  }

  const { data: live } = await db
    .from('lead_facts')
    .select('key, value, confidence, evidence, source_message_id')
    .eq('lead_id', lead_id)
    .is('superseded_at', null)

  return json({
    lead_id,
    inserted,
    superseded,
    rejected: rejections.length,
    rejections,
    facts: live ?? [],
    usage: {
      latency_ms: usage.latency_ms,
      cost_usd: usage.cost_usd,
      prompt_version: usage.prompt_version,
    },
  })
})
