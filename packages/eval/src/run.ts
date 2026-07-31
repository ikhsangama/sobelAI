import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { Fact } from '@revive/core'
import { isFailing, pipelineError, runAssertions } from './assertions.ts'
import type { Failure, FixtureExpect, Observed } from './assertions.ts'

/**
 * §10's eval harness. `pnpm eval [--only <id>] [--verbose] [--strict]`.
 *
 * Per fixture: truncate, insert agent + lead + messages, call extract-facts,
 * call generate-drafts with the fixture's `now` (service-role auth so §8's
 * override guard admits it), run assertions, write `eval_runs`.
 *
 * Truncation cascades from `agents`, so a run DESTROYS the seeded demo data
 * (trap 1). Finish with `pnpm seed`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. Get it from `supabase status -o json`.')
}
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const verbose = args.includes('--verbose')
const strict = args.includes('--strict')

interface Fixture {
  id: string
  now: string
  agent: Record<string, unknown>
  agent_b?: Record<string, unknown>
  lead: Record<string, unknown>
  messages: { direction: 'inbound' | 'outbound'; sent_at: string; body: string }[]
  expect: FixtureExpect
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture)
    .filter((f) => !only || f.id === only)
}

/** §10's per-fixture reset. agents -> leads -> messages/lead_facts/drafts all cascade. */
async function truncate(): Promise<void> {
  const { error } = await db.from('agents').delete().not('id', 'is', null)
  if (error) throw new Error(`truncate failed: ${error.message}`)
}

async function insertAgent(spec: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from('agents').insert(spec).select('id').single()
  if (error || !data) throw new Error(`inserting agent failed: ${error?.message}`)
  return data.id
}

async function insertLeadWithMessages(f: Fixture, agentId: string): Promise<string> {
  const { data: lead, error } = await db
    .from('leads')
    .insert({
      ...f.lead,
      agent_id: agentId,
      last_inbound_at: [...f.messages].reverse().find((m) => m.direction === 'inbound')?.sent_at ?? null,
      last_outbound_at: [...f.messages].reverse().find((m) => m.direction === 'outbound')?.sent_at ?? null,
    })
    .select('id')
    .single()
  if (error || !lead) throw new Error(`inserting lead failed: ${error?.message}`)

  if (f.messages.length) {
    const { error: msgErr } = await db.from('messages').insert(
      f.messages.map((m) => ({
        lead_id: lead.id,
        agent_id: agentId,
        direction: m.direction,
        body: m.body,
        sent_at: m.sent_at,
        provider: 'mock',
      })),
    )
    if (msgErr) throw new Error(`inserting messages failed: ${msgErr.message}`)
  }
  return lead.id
}

function fn(name: string, body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    // Trap 5 — §8 admits a client-supplied `now` only for the service role.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  })
}

interface RunResult {
  id: string
  failures: Failure[]
  latency_ms: number
  cost_usd: number
  prompt_version: string
  draft: string | null
}

/**
 * `Response.json()` is typed `unknown` under this tsconfig, so the two edge
 * function payloads get explicit shapes rather than a blanket `any`. Both are
 * partial on purpose — the runner should degrade to zeros on a malformed
 * response, not throw.
 */
interface ExtractResponse {
  inserted?: number
  rejected?: number
  usage?: { latency_ms?: number; cost_usd?: number; prompt_version?: string }
}

interface TraceShape {
  rule_fired?: string
  strategy?: string
  usage?: {
    write?: { latency_ms?: number; cost_usd?: number }
    tone?: { latency_ms?: number; cost_usd?: number }
  }
  guardrail?: {
    deterministic?: 'pass' | 'fail' | null
    tone?: 'pass' | 'fail' | null
    failed_rule?: string | null
    detail?: string
  }
  prompt_versions?: { write?: string }
  /** Present when generate-drafts' per-lead outcome is "error" (task 11). */
  error?: string
}

interface GenerateResponse {
  results?: { outcome?: string; trace?: TraceShape }[]
}

async function runFixture(f: Fixture): Promise<RunResult> {
  await truncate()
  const agentId = await insertAgent(f.agent)
  const leadId = await insertLeadWithMessages(f, agentId)

  const exRes = await fn('extract-facts', { lead_id: leadId, force: true })
  const exBody: ExtractResponse = exRes.ok ? ((await exRes.json()) as ExtractResponse) : {}
  const extract = { ok: exRes.ok, inserted: exBody.inserted ?? 0, rejected: exBody.rejected ?? 0 }

  // Trap 3 — structural hard fail before any other assertion runs.
  const hard = pipelineError(f.expect, extract)

  const gdRes = await fn('generate-drafts', { agent_id: agentId, lead_ids: [leadId], now: f.now })
  const gdBody: GenerateResponse = gdRes.ok ? ((await gdRes.json()) as GenerateResponse) : {}
  const result = gdBody.results?.[0] ?? null
  const trace: TraceShape = result?.trace ?? {}

  const { data: factRows } = await db.from('lead_facts').select('*').eq('lead_id', leadId)
  const { data: draftRows } = await db.from('drafts').select('body').eq('lead_id', leadId)
  // Trap 6 — §6.1: assert on the stored column, not trace.state.
  const { data: leadRow } = await db
    .from('leads')
    .select('state, snooze_until')
    .eq('id', leadId)
    .single()

  const observed: Observed = {
    facts: (factRows ?? []) as Fact[],
    state: leadRow?.state ?? null,
    rule_fired: trace.rule_fired ?? null,
    strategy: trace.strategy ?? null,
    outcome: result?.outcome ?? null,
    draftBody: draftRows?.[0]?.body ?? null,
    draftRowCount: draftRows?.length ?? 0,
    toneVerdict: trace.guardrail?.tone ?? null,
    snoozeUntil: leadRow?.snooze_until ?? null,
  }

  // SPEC-GAP: §10 defines `pipeline_error` only for extract-facts (non-200,
  // or inserted==0 && rejected==0). generate-drafts' per-lead outcome:
  // "error" (task 11's isolation fix, added after §10 was written) is a
  // different failure mode reported under its own name rather than folded
  // into §10's term, so the two never get confused when reading a failed
  // run. Reported plainly instead of falling through as a confusing generic
  // assertion failure like "no draft body to check" on whatever content
  // assertion the fixture happens to declare. Occasionally transient (an
  // empty completion from the model) — re-running `--only <id>` is the fix,
  // not a retry here.
  const llmError: Failure[] =
    observed.outcome === 'error'
      ? [{ assertion: 'generate_drafts_error', detail: `generate-drafts errored: ${trace.error ?? '(no detail)'}` }]
      : []

  // The deterministic guardrail (§6.4) and tone check (§7.3) are enforced
  // entirely inside generate-drafts, which persists a failing draft as
  // `needs_review` and moves on (Trap 5) rather than erroring. Left
  // unhandled, this outcome was invisible in the eval table — no assertion
  // inspected `observed.outcome` directly, so a fixture whose draft failed
  // G1/G2 or tone, and never even reached the independent G3 re-check,
  // could report a fully clean row.
  const needsReview: Failure[] =
    observed.outcome === 'needs_review'
      ? [
          {
            assertion: 'guardrail_failed',
            detail: `generate-drafts marked needs_review — ${trace.guardrail?.failed_rule ?? 'unknown rule'}${
              trace.guardrail?.detail ? `: ${trace.guardrail.detail}` : ''
            }`,
          },
        ]
      : []

  const failures = hard
    ? [hard]
    : llmError.length
      ? llmError
      : needsReview.length
        ? needsReview
        : runAssertions(f.expect, observed)

  const usage = trace.usage ?? {}
  const latency_ms =
    (exBody.usage?.latency_ms ?? 0) + (usage.write?.latency_ms ?? 0) + (usage.tone?.latency_ms ?? 0)
  const cost_usd =
    (exBody.usage?.cost_usd ?? 0) + (usage.write?.cost_usd ?? 0) + (usage.tone?.cost_usd ?? 0)

  // §9's two-voice comparison: same lead + messages, second agent, side by side.
  let draftB: string | null = null
  if (f.agent_b) {
    const agentBId = await insertAgent(f.agent_b)
    const leadBId = await insertLeadWithMessages(f, agentBId)
    await fn('extract-facts', { lead_id: leadBId, force: true })
    await fn('generate-drafts', { agent_id: agentBId, lead_ids: [leadBId], now: f.now })
    const { data: rows } = await db.from('drafts').select('body').eq('lead_id', leadBId)
    draftB = rows?.[0]?.body ?? null
  }

  if (verbose) {
    console.log(`\n── ${f.id} ─────────────────────────────`)
    if (observed.draftBody) console.log(`[${f.agent.name}]\n${observed.draftBody}\n`)
    if (draftB) console.log(`[${(f.agent_b as { name: string }).name}]\n${draftB}\n`)
    for (const fail of failures) {
      console.log(`  ${fail.soft ? '[soft] ' : ''}${fail.assertion}: ${fail.detail}`)
    }
  }

  return {
    id: f.id,
    failures,
    latency_ms,
    cost_usd,
    prompt_version: trace.prompt_versions?.write ?? exBody.usage?.prompt_version ?? 'n/a',
    draft: observed.draftBody,
  }
}

async function main() {
  const fixtures = loadFixtures()
  if (fixtures.length === 0) {
    console.error(only ? `No fixture matched --only ${only}` : 'No fixtures found')
    process.exit(1)
  }

  const run_id = crypto.randomUUID()
  const results: RunResult[] = []
  for (const f of fixtures) {
    results.push(await runFixture(f))
  }

  console.log('\nfixture                         | pass | failed assertions            | latency | cost')
  console.log('--------------------------------|------|------------------------------|---------|--------')
  for (const r of results) {
    const hardFail = isFailing(r.failures, strict)
    const names = r.failures.map((f) => (f.soft ? `[soft]${f.assertion}` : f.assertion)).join(', ')
    console.log(
      `${r.id.padEnd(31)} | ${(hardFail ? 'FAIL' : 'pass').padEnd(4)} | ${names.slice(0, 28).padEnd(28)} | ${String(r.latency_ms).padStart(6)}ms | $${r.cost_usd.toFixed(4)}`,
    )
    await db.from('eval_runs').insert({
      run_id,
      fixture_id: r.id,
      passed: !hardFail,
      failures: r.failures,
      latency_ms: r.latency_ms,
      cost_usd: r.cost_usd,
      prompt_version: r.prompt_version,
    })
  }

  const failed = results.filter((r) => isFailing(r.failures, strict))
  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0)
  console.log(`\n${results.length - failed.length}/${results.length} passed · $${totalCost.toFixed(4)} total`)
  if (failed.length) {
    console.log('\nRe-seed before demoing:  pnpm seed')
    process.exit(1)
  }
  console.log('\nRe-seed before demoing:  pnpm seed')
}

main().catch((err) => {
  console.error(`\neval failed: ${err.message}`)
  process.exit(1)
})
