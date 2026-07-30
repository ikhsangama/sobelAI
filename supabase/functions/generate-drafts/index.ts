import { createClient } from '@supabase/supabase-js'
import { diffDays } from '../../../packages/core/src/classify.ts'
import { factGaps } from '../../../packages/core/src/facts.ts'
import { guardrail } from '../../../packages/core/src/guardrail.ts'
import {
  DEFAULT_STRATEGY_RULES,
  selectStrategy,
} from '../../../packages/core/src/selectStrategy.ts'
import { call } from '../../../packages/llm/src/call.ts'
import * as writePrompt from '../../../packages/llm/src/prompts/write.ts'
import * as tonePrompt from '../../../packages/llm/src/prompts/toneCheck.ts'

/**
 * POST /functions/v1/generate-drafts  (§8)
 *   req: { "agent_id": "uuid", "lead_ids": ["uuid"] | null, "now": "ISO?", "dry_run": false }
 *   res: { run_id, generated, suppressed, needs_review, results: [{ lead_id, draft_id, outcome, trace }] }
 *
 * classify -> selectStrategy -> write (§7.2) -> guardrail (§6.4) -> toneCheck (§7.3).
 *
 * The only writer of `leads.state` anywhere in the system (§6.1, trap 2), and
 * the only place `suppress` is turned into "no LLM call at all" (§8, trap 1).
 */

const MODEL = 'claude-sonnet-4-6'
const WRITE_TEMPERATURE = 0.7 // §2
const TONE_TEMPERATURE = 0 // §2 and §7.3
const WRITE_MAX_TOKENS = 1024
const TONE_MAX_TOKENS = 512
const MESSAGE_WINDOW = 6 // §7.2: "LAST 6 MESSAGES"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://kong:8000'
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FactRow {
  key: string
  value: unknown
  superseded_at: string | null
}

type Outcome = 'drafted' | 'suppressed' | 'needs_review' | 'skipped'

Deno.serve(async (req) => {
  let agent_id: string
  let lead_ids: string[] | null
  let dry_run = false
  let nowRaw: string | undefined
  try {
    const payload = await req.json()
    agent_id = payload.agent_id
    lead_ids = payload.lead_ids ?? null
    dry_run = payload.dry_run === true
    nowRaw = payload.now
    if (typeof agent_id !== 'string' || !agent_id) throw new Error('agent_id is required')
    if (lead_ids !== null && !Array.isArray(lead_ids)) throw new Error('lead_ids must be an array or null')
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400)
  }

  // Trap 4 — §8's `now` override guard. A client-supplied clock is a testing
  // seam, not a public API feature.
  const isServiceRole =
    SERVICE_ROLE_KEY !== '' && req.headers.get('Authorization') === `Bearer ${SERVICE_ROLE_KEY}`
  if (nowRaw !== undefined && !dry_run && !isServiceRole) {
    return json(
      { error: '`now` override requires dry_run: true or the service-role key' },
      400,
    )
  }
  const now = nowRaw ? new Date(nowRaw) : new Date()
  if (Number.isNaN(now.getTime())) return json({ error: '`now` is not a valid date' }, 400)

  const { data: agent, error: agentErr } = await db
    .from('agents')
    .select('*')
    .eq('id', agent_id)
    .single()
  if (agentErr || !agent) return json({ error: `agent not found: ${agent_id}` }, 404)

  let leadQuery = db.from('leads').select('*').eq('agent_id', agent_id)
  if (lead_ids) leadQuery = leadQuery.in('id', lead_ids)
  const { data: leads, error: leadsErr } = await leadQuery
  if (leadsErr) return json({ error: `loading leads failed: ${leadsErr.message}` }, 500)

  // SPEC-GAP: §6.3 says rules are editable in SQL without a deploy, so read
  // them from the table; DEFAULT_STRATEGY_RULES is the fallback only if the
  // 0003 migration hasn't run.
  const { data: ruleRows } = await db.from('strategy_rules').select('*')
  const rules = ruleRows && ruleRows.length ? ruleRows : DEFAULT_STRATEGY_RULES

  const run_id = crypto.randomUUID()
  const results: unknown[] = []
  let generated = 0
  let suppressed = 0
  let needs_review = 0

  for (const lead of leads ?? []) {
    // Trap 7 — one query, four consumers.
    const { data: factRows } = await db
      .from('lead_facts')
      .select('key, value, superseded_at')
      .eq('lead_id', lead.id)
      .is('superseded_at', null)
    const facts = (factRows ?? []) as FactRow[]
    const gaps = factGaps(facts as never)

    const decision = selectStrategy({ lead, agent, rules: rules as never, factGaps: gaps, now })

    // Trap 2 — the only writer of this column, and it happens before any
    // rule outcome is acted on. `decision.state` is classify()'s own output.
    if (!dry_run) {
      await db.from('leads').update({ state: decision.state }).eq('id', lead.id)
    }

    const state_inputs = {
      days_since_inbound: lead.last_inbound_at ? diffDays(now, lead.last_inbound_at) : null,
      touch_count: lead.touch_count,
      opted_out: lead.opted_out,
    }

    const baseTrace: Record<string, unknown> = {
      state: decision.state,
      state_inputs,
      rule_fired: decision.rule_fired,
      rule_priority: decision.rule_priority,
      rules_evaluated: decision.rules_evaluated,
      strategy: decision.strategy,
      fact_gaps: gaps,
      facts_used: facts.map((f) => f.key),
      facts_referenced_by_model: [],
      guardrail: { deterministic: null, tone: null, failed_rule: null },
      usage: {},
      prompt_versions: {},
    }
    if (decision.suppressed_by_cooldown) {
      baseTrace.suppressed_by_cooldown = decision.suppressed_by_cooldown
    }

    // Trap 3 — idempotency. Checked before the LLM so a second cadence tick
    // costs nothing, not just "doesn't duplicate".
    const { data: pending } = await db
      .from('drafts')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('status', 'pending')
      .limit(1)
    if (pending && pending.length > 0) {
      results.push({
        lead_id: lead.id,
        draft_id: pending[0]!.id,
        outcome: 'skipped' satisfies Outcome,
        trace: { ...baseTrace, skipped_reason: 'existing_pending_draft' },
      })
      continue
    }

    // Trap 1 — suppress returns before the write prompt is ever built.
    if (decision.strategy === 'suppress') {
      suppressed++
      results.push({
        lead_id: lead.id,
        draft_id: null,
        outcome: 'suppressed' satisfies Outcome,
        trace: baseTrace,
      })
      continue
    }

    const { data: recent } = await db
      .from('messages')
      .select('direction, body, sent_at')
      .eq('lead_id', lead.id)
      .order('sent_at', { ascending: false })
      .limit(MESSAGE_WINDOW)
    const messages = (recent ?? []).slice().reverse()

    let written: { message?: string; facts_referenced?: string[] }
    let writeUsage
    try {
      const r = await call<{ message?: string; facts_referenced?: string[] }>({
        stage: 'write',
        model: MODEL,
        prompt_version: writePrompt.version,
        system: writePrompt.system,
        user: writePrompt.buildUser({
          agentName: agent.name,
          voice: agent.voice_profile,
          strategy: decision.strategy,
          gap: decision.strategy === 'fill_missing_fact' ? (gaps[0] ?? null) : null,
          facts: facts.map((f) => ({ key: f.key, value: f.value })),
          messages,
          daysSinceLastReply: state_inputs.days_since_inbound,
        }),
        max_tokens: WRITE_MAX_TOKENS,
        temperature: WRITE_TEMPERATURE,
      })
      written = r.parsed
      writeUsage = r.usage
    } catch (err) {
      return json({ error: `write failed for lead ${lead.id}: ${(err as Error).message}` }, 502)
    }

    const body = typeof written.message === 'string' ? written.message : ''
    const trace: Record<string, unknown> = {
      ...baseTrace,
      facts_referenced_by_model: written.facts_referenced ?? [],
      usage: { write: { latency_ms: writeUsage.latency_ms, cost_usd: writeUsage.cost_usd } },
      prompt_versions: { write: writePrompt.version },
    }

    // Deterministic guardrail (§6.4). Trap 5 — a failure saves the draft.
    const g = guardrail(body, facts as never)
    if (!g.pass) {
      trace.guardrail = { deterministic: 'fail', tone: null, failed_rule: g.failedRule, detail: g.detail }
      const draft_id = await saveDraft(lead, body, decision.strategy, trace, 'needs_review')
      needs_review++
      results.push({ lead_id: lead.id, draft_id, outcome: 'needs_review' satisfies Outcome, trace })
      continue
    }

    // Tone check (§7.3), only after the deterministic half passes.
    let verdict: tonePrompt.ToneVerdict
    let toneUsage
    try {
      const r = await call<tonePrompt.ToneVerdict>({
        stage: 'tone',
        model: MODEL,
        prompt_version: tonePrompt.version,
        system: tonePrompt.system,
        user: tonePrompt.buildUser({
          facts: facts.map((f) => ({ key: f.key, value: f.value })),
          draft: body,
        }),
        max_tokens: TONE_MAX_TOKENS,
        temperature: TONE_TEMPERATURE,
      })
      verdict = r.parsed
      toneUsage = r.usage
    } catch (err) {
      return json({ error: `tone check failed for lead ${lead.id}: ${(err as Error).message}` }, 502)
    }

    trace.usage = {
      write: { latency_ms: writeUsage.latency_ms, cost_usd: writeUsage.cost_usd },
      tone: { latency_ms: toneUsage.latency_ms, cost_usd: toneUsage.cost_usd },
    }
    trace.prompt_versions = { write: writePrompt.version, tone: tonePrompt.version }

    // Trap 5 — tone failure is needs_review with the reasons copied verbatim.
    // Never auto-retry.
    if (verdict.verdict !== 'pass') {
      trace.guardrail = {
        deterministic: 'pass',
        tone: 'fail',
        failed_rule: 'tone',
        reasons: verdict.reasons ?? [],
      }
      const draft_id = await saveDraft(lead, body, decision.strategy, trace, 'needs_review')
      needs_review++
      results.push({ lead_id: lead.id, draft_id, outcome: 'needs_review' satisfies Outcome, trace })
      continue
    }

    trace.guardrail = { deterministic: 'pass', tone: 'pass', failed_rule: null }
    const draft_id = await saveDraft(lead, body, decision.strategy, trace, 'pending')
    generated++
    results.push({ lead_id: lead.id, draft_id, outcome: 'drafted' satisfies Outcome, trace })
  }

  return json({ run_id, generated, suppressed, needs_review, results })

  /** SPEC-GAP: dry_run persists nothing — no draft, no leads.state write. */
  async function saveDraft(
    lead: { id: string; agent_id: string },
    body: string,
    strategy: string,
    trace: Record<string, unknown>,
    status: 'pending' | 'needs_review',
  ): Promise<string | null> {
    if (dry_run) return null
    const { data, error } = await db
      .from('drafts')
      .insert({
        run_id,
        lead_id: lead.id,
        agent_id: lead.agent_id,
        strategy,
        body,
        status,
        trace,
      })
      .select('id')
      .single()
    if (error) {
      console.error(JSON.stringify({ save_draft_failed: { lead_id: lead.id, error: error.message } }))
      return null
    }
    return data.id
  }
})
