# Task 11 — `generate-drafts`

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 11:

> `generate-drafts`: orchestrate classify → selectStrategy → write (7.2) → guardrail → toneCheck (7.3). Build the full `trace` object per §8, including the pending-draft skip and the `now`-override guard. This is the core deliverable — get the trace shape exactly right.
>
> **Checkpoint: freeze `extract-v1`, `write-v1`, `tone-v1` here.** No prompt edits until task 16 is done — an edit after 12 goes green invalidates the baseline the planted regression demos against.

**Outcome:** the thing the whole repo exists to do. Everything before this was a component; this is the pipeline. The `trace` object it writes is what the TracePanel (task 15) renders and what the eval harness (task 12) asserts against — §11 says *"get the trace shape exactly right"* because two later tasks are built on it.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| The eval harness and fixtures | Task 12 |
| `/queue` UI, approve/skip mutations | Task 13 |
| `TracePanel` | Task 15 |
| `write-v2` (the planted regression) | Task 16 |
| `0005_approve_draft.sql` | Still outstanding; A1 allows it any time before task 13 |

Everything you need to type is written out in full below.

---

## Read this before you start

### Eight traps

**Trap 1 — `suppress` must never reach the LLM.**
§8 is explicit: if `selectStrategy()` returns `strategy: 'suppress'`, return immediately with `outcome: 'suppressed'`, no `drafts` row, and **no `usage.write` entry** — the write prompt is never built, so there is no cost to report. Getting this wrong doesn't just waste money; §7.2 states the write prompt has no `suppress` branch precisely because this check makes it structurally unreachable. If a suppressed lead reaches the prompt, the model gets a strategy it has no definition for.

**This is also what makes the task testable without an API key** — see Step 5.

**Trap 2 — `generate-drafts` is the *only* writer of `leads.state`.**
§6.1 and §8 both say so, and task 4 ships a guard test. Write it **before evaluating rules**, from `classify(lead, now)`. Use the `state` that `selectStrategy()` already returns rather than calling `classify()` a second time — `selectStrategy` calls it internally for exactly this reason, and one call site means the state stored in the column cannot drift from the state reported in the trace.

**Trap 3 — the pending-draft skip is what stops "Run cadence tick" doubling the queue.**
§8: skip the lead, record `outcome: "skipped"` and `trace.skipped_reason: "existing_pending_draft"`. The database has `drafts_one_pending_per_lead` (§3) as a backstop, but relying on the unique-violation error instead of checking first turns an ordinary second click into a 500.

Note the index is `where status = 'pending'` — a `needs_review` draft does **not** block a later run. That is per spec, not an oversight.

**Trap 4 — the `now` override needs a guard, and the check is a string comparison.**
§8: reject with 400 unless `dry_run: true` **or** the caller presents the service-role key. Verified against the running edge runtime: the `Authorization` header arrives intact, and comparing it to `` `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` `` cleanly distinguishes service-role (`true`) from anon (`false`) and no-header (`false`). No JWT parsing needed — that is the simplest thing that satisfies the rule.

**Trap 5 — a guardrail failure saves the draft, it does not drop it.**
§6.4: *"Failure → draft saved with `status='needs_review'` and the failed rule in the trace. **Never drop silently.**"* Same for a tone failure: `status='needs_review'`, `trace.guardrail.failed_rule = 'tone'`, and the model's `reasons` array copied into the trace **verbatim**. **Never auto-retry** — §6.4 says a silent retry makes the trace panel's cost and latency numbers understate what the draft actually cost.

**Trap 6 — `facts_used` and `facts_referenced_by_model` are two different things, and both are logged.**
§8 spells this out: `facts_used` is what the pipeline decided was relevant (the keys in the FACTS block you gave the model); `facts_referenced_by_model` is the `facts_referenced` array the model returned. A model referencing a fact outside `facts_used` is *"a signal worth seeing in the trace panel even though it isn't (yet) a hard failure."* Do not collapse them into one field, and do not fail the draft on a mismatch.

**Trap 7 — the guardrail runs against live facts only.**
`guardrail(draft, facts)` (task 6) already filters `superseded_at`, but you must pass it the fact rows, not a flattened map. Load facts once with `superseded_at is null` and reuse that array for `factGaps()`, the FACTS block, `facts_used`, and the guardrail — four consumers, one query, no chance of them disagreeing.

**Trap 8 — freeze the prompts after this task.**
§11's checkpoint. Once task 12's fixtures go green, editing `write-v1` invalidates the baseline that task 16's planted regression demos against. If you find a prompt problem after this, note it and fix it after task 16 — don't quietly reword.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Local Supabase must be running (`supabase start`) and seeded (`pnpm seed`).

---

## Step 1 — `packages/llm/src/prompts/write.ts`

§7.2 verbatim, with `MAX_DRAFT_CHARS` interpolated from `sg-rules.ts` so the prompt and G1 can never disagree about the number. Create the file with exactly this content:

```ts
import { MAX_DRAFT_CHARS } from '../../../core/src/sg-rules.ts'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'write-v1'

export const system = `You draft a single WhatsApp follow-up message that a Singapore property agent
will read and approve before it is sent. You are ghostwriting as the agent.

Hard constraints:
- Output ONLY a JSON object: {"message":..,"facts_referenced":[..],"confidence":0-1}
- ONE message. Under ${MAX_DRAFT_CHARS} characters. WhatsApp register: short lines,
  no subject line, no letter formatting, no signature block.
- You may ONLY reference facts present in FACTS below. Do not mention any
  price, district, date, project name, or unit type that is not there.
- Never invent listings, viewings, appointments, or market statistics.
- Never state that the lead is eligible for anything, will qualify for
  anything, or that a property will appreciate. If eligibility is relevant,
  ASK about it with a question mark.
- No pressure tactics, no false scarcity, no guarantees.
- Do not apologise for following up. Do not say "just checking in" verbatim.
- Write in the agent's voice per VOICE below.

Strategy definitions — follow the one given exactly:
- soft_check_in: light, low-obligation re-open. Reference something specific
  from the earlier conversation. Give them an easy out.
- new_listing_hook: mention that something matching their stated criteria has
  come up. Describe it ONLY using their own stated criteria — no invented
  address, price, or project name. End with a yes/no question.
- fill_missing_fact: ask for exactly ONE missing detail: <GAP>. Explain in one
  clause why it helps you help them.
- instant_qualify: first contact from an ad. Introduce the agent by name, note
  where the enquiry came from, ask at most TWO qualifying questions.
- market_update: long-dormant. Offer general, non-numeric context about their
  area of interest and ask if their plans have changed.
- final_nudge: last message before going quiet. Say plainly that you will stop
  following up, and leave the door open. No guilt, no urgency.`

export interface VoiceProfile {
  formality: number
  warmth: number
  brevity: number
  emoji_ok: boolean
  sign_off: string
  sample_messages: string[]
}

export interface WritePromptInput {
  agentName: string
  voice: VoiceProfile
  strategy: string
  /** The single fact key to ask for, when strategy is fill_missing_fact. */
  gap: string | null
  /** `key: value` pairs — the ONLY facts the model may reference. */
  facts: { key: string; value: unknown }[]
  /** Oldest-first; §7.2 asks for the last 6. */
  messages: { direction: 'inbound' | 'outbound'; body: string }[]
  daysSinceLastReply: number | null
}

/** §7.2's USER block, in the order the contract writes it. */
export function buildUser(input: WritePromptInput): string {
  const { agentName, voice, strategy, gap, facts, messages, daysSinceLastReply } = input

  const factLines = facts.length
    ? facts.map((f) => `${f.key}: ${JSON.stringify(f.value)}`).join('\n')
    : '(none)'

  const samples = voice.sample_messages.slice(0, 3)
  const sampleLines = samples.length ? samples.map((s) => `- ${s}`).join('\n') : '(none)'

  const messageLines = messages.length
    ? messages.map((m, i) => `${i}: ${m.direction}: ${m.body}`).join('\n')
    : '(none)'

  return [
    `AGENT NAME: ${agentName}`,
    `VOICE: formality ${voice.formality}/5, warmth ${voice.warmth}/5, brevity ${voice.brevity}/5, emoji ${voice.emoji_ok ? 'ok' : 'no'},`,
    `       sign-off: "${voice.sign_off}"`,
    `SAMPLE MESSAGES BY THIS AGENT (match the rhythm, not the content):`,
    sampleLines,
    `STRATEGY: ${strategy}`,
    `GAP TO FILL (if any): ${gap ?? '(none)'}`,
    `FACTS (the ONLY facts you may reference):`,
    factLines,
    `LAST 6 MESSAGES:`,
    messageLines,
    `DAYS SINCE LEAD LAST REPLIED: ${daysSinceLastReply ?? '(never replied)'}`,
  ].join('\n')
}
```

> **Why the import is a relative leaf path**, not `@revive/core`: amendment A6. `supabase functions serve` discovers dependencies by walking literal relative specifiers, so an import-map alias typechecks but fails to boot.

---

## Step 2 — `packages/llm/src/prompts/toneCheck.ts`

§7.3 verbatim. Note `temperature 0` — that is set by the caller in Step 4, not here. Create the file with exactly this content:

```ts
import { MAX_DRAFT_CHARS } from '../../../core/src/sg-rules.ts'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'tone-v1'

export const system = `You are a strict reviewer. Judge one drafted WhatsApp message from a Singapore
property agent to a lead.

Output ONLY: {"verdict":"pass"|"fail","reasons":[".."]}

Fail if ANY of:
- Pushy, guilt-inducing, or manufacturing urgency
- Claims or implies eligibility, approval, returns, or appreciation
- References a specific price, district, project, date, or unit type NOT in FACTS
- Reads as a mass template rather than a message to this person
- Longer than ${MAX_DRAFT_CHARS} characters, or formatted like an email
- Apologetic or servile in tone

Be strict. A false fail costs one draft. A false pass costs the agent's
reputation and possibly their WhatsApp number.`

export interface ToneCheckInput {
  facts: { key: string; value: unknown }[]
  draft: string
}

export interface ToneVerdict {
  verdict: 'pass' | 'fail'
  reasons: string[]
}

/** §7.3's USER block. */
export function buildUser(input: ToneCheckInput): string {
  const factLines = input.facts.length
    ? input.facts.map((f) => `${f.key}: ${JSON.stringify(f.value)}`).join('\n')
    : '(none)'
  return `FACTS: ${factLines}\nDRAFT: ${input.draft}`
}
```

---

## Step 3 — `packages/llm/src/index.ts`

Add the two namespace exports alongside the existing one:

```ts
export * from './call'
export * as extractPrompt from './prompts/extract'
export * as writePrompt from './prompts/write'
export * as tonePrompt from './prompts/toneCheck'
```

Namespaces, not `export *` — all three prompts export `version`, `system` and `buildUser`, so a flat re-export would collide on every one of them.

---

## Step 4 — `supabase/functions/generate-drafts/index.ts`

The orchestrator. Create the file with exactly this content:

```ts
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
```

Four things worth noticing:

- **The idempotency check runs before the LLM call**, not after. §8 only requires no duplicate row; checking first also means a second cadence tick costs nothing.
- **`decision.state` is reused**, never a second `classify()` call — trap 2.
- **The trace always has the same keys.** Suppressed leads get `guardrail: {deterministic: null, ...}`, `usage: {}` and `prompt_versions: {}` rather than missing fields, so the TracePanel (task 15) and the eval assertions (task 12) can read a stable shape. §8 says explicitly there is *"no `usage.write` entry to report"* for a suppressed lead — an empty object, not a zero.
- **// SPEC-GAP: §8's response has three counters** (`generated`, `suppressed`, `needs_review`) and no `skipped` counter, even though `skipped` is a documented outcome. Left exactly as §8 writes it; skipped leads are still visible in `results`.

---

## Step 5 — run it

```bash
cd $REPO
supabase start                # if not already running
pnpm seed
supabase functions serve --no-verify-jwt --env-file .env.local
```

### 5a — the part that works without an `ANTHROPIC_API_KEY`

Trap 1 means suppressed leads never call the LLM, so their whole path — classify, rule selection, the `leads.state` write, and the full trace shape — is testable with no key at all. Two seeded leads suppress: **Kelvin Ong** (opted out → `hard_suppress`) and **Siti Rahman** (warm with `touch_count > 0` → `warm_human_handles`).

```bash
cd $REPO
AGENT=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id from agents where name='Wei Ling';")
KELVIN=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id from leads where name='Kelvin Ong';")
SITI=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id from leads where name='Siti Rahman';")

curl -s -X POST http://127.0.0.1:54321/functions/v1/generate-drafts \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_ids\":[\"$KELVIN\",\"$SITI\"]}" | head -60
```

Expect `"suppressed": 2`, `"generated": 0`, and for each result `outcome: "suppressed"`, `draft_id: null`, `usage: {}`. Kelvin's `rule_fired` must be `hard_suppress` (priority 100) and Siti's `warm_human_handles` (priority 80).

Then confirm trap 2 — the `leads.state` write actually happened:

```bash
cd $REPO
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select name, state from leads where name in ('Kelvin Ong','Siti Rahman');"
```

Expect `do_not_contact` and `warm` — **not** the seed's `new` placeholder. This is the one column §6.1 reserves for this function, so seeing it change here is the proof it works.

Now the `now`-override guard (trap 4):

```bash
cd $REPO
echo "--- now override with no auth: must be 400 ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/generate-drafts \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_ids\":[\"$KELVIN\"],\"now\":\"2026-01-01T00:00:00Z\"}" \
  -w "\nHTTP %{http_code}\n"

echo "--- same, but dry_run: must be 200 ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/generate-drafts \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_ids\":[\"$KELVIN\"],\"now\":\"2026-01-01T00:00:00Z\",\"dry_run\":true}" \
  -w "\nHTTP %{http_code}\n" -o /dev/null
```

Expect `400` then `200`.

### 5b — the part that needs a real key

Set `ANTHROPIC_API_KEY` in `.env.local`, restart `supabase functions serve`, then run extraction first (facts drive `fact_gaps`, which drives the rule) and generate for everyone:

```bash
cd $REPO
for L in "Marcus Tan" "Priya Nair" "Rachel Goh"; do
  ID=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
    "select id from leads where name='$L';")
  curl -s -X POST http://127.0.0.1:54321/functions/v1/extract-facts \
    -H 'Content-Type: application/json' -d "{\"lead_id\":\"$ID\"}" > /dev/null
done
curl -s -X POST http://127.0.0.1:54321/functions/v1/generate-drafts \
  -H 'Content-Type: application/json' -d "{\"agent_id\":\"$AGENT\"}" |
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
    console.log('generated',j.generated,'suppressed',j.suppressed,'needs_review',j.needs_review);
    for(const r of j.results) console.log(' ', r.outcome.padEnd(13), r.trace.rule_fired.padEnd(20), r.trace.strategy)})"
```

> **Without extraction having run, every cold/dormant lead has all four required facts missing**, so `gap_fill` (priority 60) wins for all of them and `listing_hook`/`long_dormant` never fire. That is correct behaviour, not a bug — it just means 5b is the only way to see those two rules.

Then the idempotency check (trap 3) — run the exact same command a second time:

```bash
cd $REPO
curl -s -X POST http://127.0.0.1:54321/functions/v1/generate-drafts \
  -H 'Content-Type: application/json' -d "{\"agent_id\":\"$AGENT\"}" |
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
    console.log('generated',j.generated);
    console.log('skipped:',j.results.filter(r=>r.outcome==='skipped').length)})"
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select lead_id, count(*) from drafts where status='pending' group by lead_id having count(*) > 1;"
```

Expect `generated 0`, a non-zero `skipped`, and **zero rows** from the SQL — that last one is `drafts_one_pending_per_lead` holding, which is §12's "clicking Run cadence tick twice does not double the queue" checkbox.

---

## Step 6 — full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
docker run --rm -v "$(pwd)":/work -w /work --entrypoint deno denoland/deno:alpine-2.1.4 \
  check --config supabase/functions/deno.json supabase/functions/generate-drafts/index.ts
```

All four exit 0. `pnpm test` still reports **168 tests** — this task adds no unit tests, because everything deterministic in it (`classify`, `selectStrategy`, `guardrail`, `factGaps`) is already covered by tasks 4–6, and the orchestration itself is what task 12's eval harness exists to test end-to-end.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| A suppressed lead has a `usage.write` entry | The suppress check runs after the write call | Trap 1 — return before building the prompt |
| `leads.state` still says `new` after a run | The state write was skipped or placed after the rule evaluation | Trap 2 — write it before acting on the decision |
| Second cadence tick doubles the queue | No pending-draft check | Trap 3 |
| `duplicate key value violates drafts_one_pending_per_lead` | Same as above; the DB caught what the code didn't | Trap 3 — check first, don't rely on the error |
| `now` accepted from an unauthenticated caller | Guard missing | Trap 4 — 400 unless `dry_run` or service-role |
| A guardrail failure produces no `drafts` row | The failure path dropped the draft | Trap 5 — save it with `status='needs_review'` |
| `facts_referenced_by_model` always `[]` on drafted leads | The model's `facts_referenced` array was discarded | Trap 6 |
| `Module not found ".../packages/core/src/index.ts"` | Imported the `@revive/core` barrel | Amendment A6 — import leaf files by relative path |
| `write failed ... ANTHROPIC_API_KEY is not set` | No key in `.env.local` | Expected; use Step 5a's suppressed-lead path instead |

---

## Step 7 — Acceptance and commit

### Checklist

- [ ] `suppress` returns before any LLM call, with `usage: {}` and no `drafts` row
- [ ] `leads.state` written from `decision.state` **before** the rule outcome is acted on, and nowhere else in the repo
- [ ] Pending-draft skip records `outcome: "skipped"` and `trace.skipped_reason: "existing_pending_draft"`
- [ ] `now` override returns 400 unless `dry_run: true` or the service-role key is presented
- [ ] Guardrail failure → draft saved as `needs_review` with the failed rule in the trace
- [ ] Tone failure → `needs_review`, `failed_rule: 'tone'`, model `reasons` copied verbatim, **no retry**
- [ ] `facts_used` and `facts_referenced_by_model` both present and distinct
- [ ] Trace carries every §8 key on every path, including suppressed
- [ ] Prompts export `{ version, system, buildUser }`; `MAX_DRAFT_CHARS` interpolated, not hardcoded
- [ ] `pnpm typecheck`, `pnpm test` (168), `pnpm --filter @revive/web build`, `deno check` all exit 0

### Expected tree

```
$REPO/
├── packages/llm/src/
│   ├── index.ts                      # edited: +writePrompt, +tonePrompt
│   └── prompts/
│       ├── write.ts                  # new
│       └── toneCheck.ts              # new
└── supabase/functions/
    └── generate-drafts/index.ts      # new
```

`supabase/functions/deno.json` does **not** change. No migration. No new tests.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 11: generate-drafts orchestration + write/tone prompts"
```

Then update **Current state** in `CLAUDE.md`.

---

## Next

**Freeze the prompts.** §11's checkpoint sits exactly here: `extract-v1`, `write-v1` and `tone-v1` are frozen until task 16 is done. Task 12's fixtures establish a baseline; task 16 plants `write-v2` and proves it turns F19/F20 red. Editing a prompt in between means the regression demo has nothing stable to regress *from*.

**`0005_approve_draft.sql`** (amendment A1) is still outstanding and is now the last thing standing between here and task 13's queue UI. §8 specifies it: quiet-hours check (SGT hour within `[quiet_hours_start, quiet_hours_end)`, else 409 `outside_quiet_hours`), the mock send, the outbound `messages` insert, and `touch_count += 1` / `last_outbound_at` / `resolved_at` / `status` — all in one transaction.

**Task 12 — the eval harness**, which is what actually tests this task. §11 calls it and task 16 the two deliverables that can't be faked in a live demo. It replays 12 fixtures through `extract-facts` and `generate-drafts` with a pinned `now` (which is why trap 4's guard accepts the service-role key), asserts on the trace shape this task produces, and prints the two-voice comparison seeded at task 8.
