# Task 10 — `ingest-inbound` + opt-out/snooze detection

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 10:

> `ingest-inbound` + opt-out/snooze keyword detection (§6.2) + tests.

**Outcome:** the entry point for everything a lead says. It records the message, decides whether the lead just opted out or asked to be left alone for a while, updates the lead row, and hands off to `extract-facts` (task 9).

**This task contains the only irreversible write in the system.** `opted_out = true` makes `classify()` return `do_not_contact`, which `hard_suppress` (priority 100) then silences forever. Nothing in the contract un-opts-out a lead. Trap 1 is about that, and it is the whole reason this task needs care rather than a ten-line `includes()` loop.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `generate-drafts` orchestration | Task 11 |
| Writing `leads.state` | Task 11 — **never here**, see trap 3 |
| Eval fixtures (F05, F07 exercise this) | Task 12 |
| `0005_approve_draft.sql` | Still outstanding; A1 allows it any time before task 13 |

Everything you need to type is written out in full below.

---

## Read this before you start

### Six traps

**Trap 1 — a plain `includes()` on §6.2's list opts out live leads, and there is no undo.**
§6.2 says "lowercase and check for: `stop`, `unsubscribe`, …", which reads as a substring scan. Run that against ordinary Singapore property chat and the bare `stop` entry fires on every one of these:

```
can i stop by the showflat this weekend?     is there a bus stop nearby?
ok i will stop by tomorrow after work        the mrt stop is quite far right
we can stop at 1.2m if the unit is good      non-stop flights from changi
i stopped looking at D15, focusing on D19    my agent stopped replying
```

Measured, not guessed: 8 out of 8 realistic non-opt-out messages false-positive. Each one permanently kills a lead who was actively engaging — *"can i stop by the showflat"* is a buying signal, and it would silence that lead for the life of the demo.

**Resolution (amendment A7, below):** `stop` matches **only as an entire message** — the actual SMS opt-out convention, and the reading that stops §6.2's own separate `stop messaging` entry from being redundant. Every other keyword matches on word boundaries. In-sentence intent is still caught by the longer phrases, so nothing in §6.2's list becomes unreachable.

**Note the seed does not catch this.** All 46 seeded messages produce exactly one keyword hit (Kelvin Ong's *"pls stop messaging me, already bought"*, correctly), under both the naive and the corrected matcher. The false positives only appear if you write tests for them deliberately — which is why Step 2's test file has a `describe` block dedicated to them.

**Trap 2 — the detector is a pure function with `sentAt` injected, not `Date.now()`.**
Contract rule 3. `snooze_until` is measured from **when the lead said it**, not from when the request happens to run — those differ whenever `sent_at` is backdated, which the eval harness (task 12) does constantly. Pass the date in.

**Trap 3 — `ingest-inbound` must NOT write `leads.state`.**
§6.1 is explicit: `leads.state` is a denormalized cache whose only writer anywhere in the system is `generate-drafts` — *"`ingest-inbound` never touches it, even though it does touch `opted_out`."* Task 4 shipped a guard test for exactly this. Setting `state = 'do_not_contact'` here because it feels right will break that test and the invariant it protects.

**Trap 4 — opt-out beats snooze, and only one keyword is reported.**
A real message can carry both (*"stop messaging me, call me next year"*). Opt-out is the stronger and safer signal, so it wins and `snooze_until` stays null. Within each list, the **first match in §6.2's own written order** is the one reported — which is why *"call me next month"* reports itself rather than the shorter `next month` that also matches.

**Trap 5 — phone keyboards emit curly apostrophes.**
§6.2 lists `don't message` with a straight quote. A real WhatsApp message says `don’t message me` (U+2019) and would miss it entirely. Normalise `’` → `'` before matching. Cheap, and it closes a gap that would otherwise only show up in a live demo.

**Trap 6 — one edge function can call another; the URL is internal.**
`ingest-inbound` calls `extract-facts` last (§8). Verified working inside the real edge runtime: `Deno.env.get('SUPABASE_URL')` is `http://kong:8000` there, and `fetch(\`${SUPABASE_URL}/functions/v1/extract-facts\`)` reaches it. Use the service-role key in an `Authorization: Bearer` header. Do **not** try to import `extract-facts/index.ts` — it is a `Deno.serve` module, not a library.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Local Supabase must be running (`supabase start`) and seeded (`pnpm seed`).

---

## Step 1 — `packages/core/src/keywords.ts`

Create the file with exactly this content:

```ts
/**
 * §6.2's opt-out and snooze detection. Deterministic, no LLM, no clock —
 * `sentAt` is injected (contract rule 3), because `snooze_until` is measured
 * from when the lead said it, not from when this happens to run.
 *
 * Runs on every inbound in `ingest-inbound` (§8). An opt-out here is the one
 * irreversible write in the system: it makes `classify()` return
 * `do_not_contact`, which `hard_suppress` (priority 100) then silences
 * permanently. Nothing in the contract un-opts-out a lead. That asymmetry is
 * why the matching below is stricter than a plain substring scan.
 */

/** §6.2's opt-out list, verbatim and in the order it is written there. */
export const OPT_OUT_KEYWORDS = [
  'stop',
  'unsubscribe',
  'remove me',
  "don't message",
  'dont message',
  'stop messaging',
  'not interested anymore',
  'already bought',
  'already rented',
  'found already',
  'got already',
  'dont contact',
] as const

/** §6.2's snooze list, verbatim and in the order it is written there. */
export const SNOOZE_KEYWORDS = [
  'call me next month',
  'next month',
  'after cny',
  'after chinese new year',
  'q1',
  'next year',
  'busy now',
] as const

/** §6.2: "+30 days default; +60 for 'next year'". */
export const SNOOZE_DAYS_DEFAULT = 30
export const SNOOZE_DAYS_NEXT_YEAR = 60

const MS_PER_DAY = 86_400_000

/**
 * // SPEC-GAP: §6.2 says "lowercase and check for" these strings, which reads
 * as a plain `includes()`. Running that against ordinary property chat makes
 * `stop` fire on all of these, every one a permanent opt-out of a live lead:
 *
 *   "can i stop by the showflat this weekend?"   "is there a bus stop nearby?"
 *   "ok i will stop by tomorrow after work"      "the mrt stop is quite far"
 *   "we can stop at 1.2m if the unit is good"    "non-stop flights from changi"
 *   "i stopped looking at D15"                   "my agent stopped replying"
 *
 * `stop` is therefore matched only as an entire message — the actual SMS
 * opt-out convention, and the reading that keeps §6.2's own `stop messaging`
 * entry from being redundant. In-sentence intent is still caught by the
 * longer phrases (`stop messaging`, `dont contact`, ...), so nothing in
 * §6.2's list becomes unreachable.
 */
const WHOLE_MESSAGE_ONLY: ReadonlySet<string> = new Set(['stop'])

export interface KeywordDetection {
  /** True when an opt-out keyword fired. Irreversible downstream. */
  opted_out: boolean
  /** ISO timestamp, or null when no snooze keyword fired. */
  snooze_until: string | null
  /** §6.2: "Log which keyword fired". Null when nothing matched. */
  keyword_hit: string | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Phone keyboards emit curly apostrophes, so "don't message me" arrives as
 * "don’t message me" and would miss §6.2's straight-quoted `don't message`.
 */
function normalize(body: string): string {
  return body.toLowerCase().replace(/[‘’]/g, "'").trim()
}

/** Alphanumerics only — so "STOP", "stop." and " Stop " all compare equal. */
function bareWord(text: string): string {
  return text.replace(/[^a-z0-9]/g, '')
}

function matches(text: string, keyword: string): boolean {
  if (WHOLE_MESSAGE_ONLY.has(keyword)) return bareWord(text) === bareWord(keyword)
  // Digit-aware boundaries: `\b` would let `q1` match inside "q12".
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(keyword)}(?![a-z0-9])`).test(text)
}

/**
 * Opt-out wins over snooze — it is the stronger, safer signal, and a message
 * can carry both ("stop messaging me, call me next year"). Within each list,
 * the first match in §6.2's own order is the one reported.
 */
export function detectKeywords(body: string, sentAt: Date): KeywordDetection {
  const text = normalize(body)

  for (const keyword of OPT_OUT_KEYWORDS) {
    if (matches(text, keyword)) {
      return { opted_out: true, snooze_until: null, keyword_hit: keyword }
    }
  }

  for (const keyword of SNOOZE_KEYWORDS) {
    if (matches(text, keyword)) {
      const days = keyword === 'next year' ? SNOOZE_DAYS_NEXT_YEAR : SNOOZE_DAYS_DEFAULT
      return {
        opted_out: false,
        snooze_until: new Date(sentAt.getTime() + days * MS_PER_DAY).toISOString(),
        keyword_hit: keyword,
      }
    }
  }

  return { opted_out: false, snooze_until: null, keyword_hit: null }
}
```

Add it to the barrel, `packages/core/src/index.ts` (note the `.ts`, per task 9's step 1):

```ts
export * from './keywords.ts'
```

> **Known limitation, deliberately not fixed.** `q1` still matches *"q1 facing units"* — a real Singapore stack/facing term — and would snooze that lead for 30 days. It is left alone because a snooze **expires**, so the failure is self-correcting, and narrowing it further means inventing business logic §6.2 doesn't specify. Mention it in the README's limitations section (task 17). The `stop` case got fixed instead precisely because opt-out does *not* expire.

---

## Step 2 — `packages/core/src/keywords.test.ts`

Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import {
  OPT_OUT_KEYWORDS,
  SNOOZE_KEYWORDS,
  SNOOZE_DAYS_DEFAULT,
  SNOOZE_DAYS_NEXT_YEAR,
  detectKeywords,
} from './keywords'

const SENT_AT = new Date('2026-07-30T12:00:00.000Z')
const detect = (body: string) => detectKeywords(body, SENT_AT)
const daysAfter = (n: number) =>
  new Date(SENT_AT.getTime() + n * 86_400_000).toISOString()

describe('§6.2 keyword lists are transcribed exactly', () => {
  it('carries all 12 opt-out keywords in the contract order', () => {
    expect(OPT_OUT_KEYWORDS).toEqual([
      'stop',
      'unsubscribe',
      'remove me',
      "don't message",
      'dont message',
      'stop messaging',
      'not interested anymore',
      'already bought',
      'already rented',
      'found already',
      'got already',
      'dont contact',
    ])
  })

  it('carries all 7 snooze keywords in the contract order', () => {
    expect(SNOOZE_KEYWORDS).toEqual([
      'call me next month',
      'next month',
      'after cny',
      'after chinese new year',
      'q1',
      'next year',
      'busy now',
    ])
  })

  it('every opt-out keyword actually fires on a message containing it', () => {
    for (const keyword of OPT_OUT_KEYWORDS) {
      // `stop` is whole-message-only by design; the rest work in a sentence.
      const body = keyword === 'stop' ? 'stop' : `hi there, ${keyword} please`
      expect(detect(body).opted_out, `keyword "${keyword}" never fires`).toBe(true)
    }
  })

  it('every snooze keyword actually fires on a message containing it', () => {
    for (const keyword of SNOOZE_KEYWORDS) {
      const r = detect(`ok lah ${keyword} then`)
      expect(r.snooze_until, `keyword "${keyword}" never fires`).not.toBeNull()
    }
  })
})

describe('opt-out detection', () => {
  it('opts out on a bare "stop" regardless of case or punctuation', () => {
    for (const body of ['stop', 'STOP', 'Stop.', '  stop  ', 'stop!']) {
      expect(detect(body)).toEqual({ opted_out: true, snooze_until: null, keyword_hit: 'stop' })
    }
  })

  it('reports the specific phrase, not bare "stop", for an in-sentence opt-out', () => {
    const r = detect('pls stop messaging me, already bought')
    expect(r.opted_out).toBe(true)
    expect(r.keyword_hit).toBe('stop messaging')
  })

  it('matches a curly apostrophe, which is what phone keyboards emit', () => {
    expect(detect('don’t message me again').opted_out).toBe(true)
    expect(detect("don't message me again").opted_out).toBe(true)
  })

  it('never sets snooze_until when opting out', () => {
    const r = detect('stop messaging me, call me next year maybe')
    expect(r.opted_out).toBe(true)
    expect(r.snooze_until).toBeNull()
  })
})

describe('opt-out false positives — the whole reason `stop` is whole-message-only', () => {
  // Every one of these permanently kills a live lead under a plain substring
  // read of §6.2. `opted_out` has no reverse anywhere in the contract.
  const ordinary = [
    'can i stop by the showflat this weekend?',
    'ok i will stop by tomorrow after work',
    'is there a bus stop nearby?',
    'the mrt stop is quite far right',
    'i stopped looking at D15, focusing on D19 now',
    'non-stop flights from changi, so location matters',
    'my agent stopped replying so im looking again',
    'we can stop at 1.2m if the unit is good',
  ]

  for (const body of ordinary) {
    it(`does not opt out: "${body}"`, () => {
      expect(detect(body).opted_out).toBe(false)
    })
  }
})

describe('snooze detection', () => {
  it('defaults to +30 days', () => {
    const r = detect('call me next month')
    expect(r.snooze_until).toBe(daysAfter(SNOOZE_DAYS_DEFAULT))
    expect(r.keyword_hit).toBe('call me next month')
    expect(r.opted_out).toBe(false)
  })

  it('uses +60 days for "next year" only', () => {
    expect(detect('maybe next year lah').snooze_until).toBe(daysAfter(SNOOZE_DAYS_NEXT_YEAR))
    expect(detect('busy now, ping me later').snooze_until).toBe(daysAfter(SNOOZE_DAYS_DEFAULT))
  })

  it('measures the snooze from sentAt, not from the current clock', () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z')
    expect(detectKeywords('busy now', earlier).snooze_until).toBe(
      new Date(earlier.getTime() + SNOOZE_DAYS_DEFAULT * 86_400_000).toISOString(),
    )
  })

  it('reports the more specific phrase when both would match', () => {
    // "call me next month" precedes "next month" in §6.2's order.
    expect(detect('call me next month ok').keyword_hit).toBe('call me next month')
  })
})

describe('no match', () => {
  it('returns all-clear for an ordinary message', () => {
    expect(detect('looking at katong area, budget around 1.5m for a 3 bedder')).toEqual({
      opted_out: false,
      snooze_until: null,
      keyword_hit: null,
    })
  })

  it('does not match a keyword embedded in a longer token', () => {
    // `q1` must not fire inside "q12"; digit-aware boundaries, not \b.
    expect(detect('stack q12 please').keyword_hit).toBeNull()
  })
})
```

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -5
```

**166 tests** (144 + 22), all green. The `does not opt out:` block is 8 of those — if any of them go red, `stop` has gone back to substring matching and the demo will silence a live lead.

---

## Step 3 — `supabase/functions/ingest-inbound/index.ts`

Create the file with exactly this content:

```ts
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

  // §8: last_inbound_at and touch_count always; opt-out/snooze only when hit.
  // `state` is intentionally absent — trap 3.
  const leadUpdate: Record<string, unknown> = {
    last_inbound_at: sentAtIso,
    touch_count: 0,
  }
  if (detection.opted_out) leadUpdate.opted_out = true
  if (detection.snooze_until) leadUpdate.snooze_until = detection.snooze_until

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
```

Three things worth noticing:

- **The message is inserted before detection runs.** A lead's opt-out is still part of the thread and belongs in the transcript — the `/leads/:id` view (task 14) would look broken with a gap where the last message should be.
- **`agent_id` is verified against the lead**, returning 403 on mismatch. §8's request carries both, and the demo runs on a hardcoded `agent_id`; checking they agree costs one comparison and turns a silent cross-tenant write into a clear error. RLS is not exercised here (service role bypasses it — §8), so this is the only tenant check on the path.
- **No `deno.json` change is needed.** `@supabase/supabase-js` is already mapped from task 9, and `keywords.ts` is reached by a literal relative specifier, which is what the edge runtime's bind-mount discovery requires (task 9 learned this the hard way — see amendment A6).

---

## Step 4 — run it

```bash
cd $REPO
supabase start                # if not already running
pnpm seed                     # reset the leads to a known state
supabase functions serve --no-verify-jwt --env-file .env.local
```

Leave that running. In a second terminal:

```bash
cd $REPO
MARCUS=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id from leads where name='Marcus Tan' limit 1;")
AGENT=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select agent_id from leads where id='$MARCUS';")

echo "--- ordinary message: no keyword, touch_count resets ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/ingest-inbound \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_id\":\"$MARCUS\",\"body\":\"can i stop by the showflat this weekend?\"}"
echo
```

Expect `opt_out_detected: false` and `keyword_hit: null`. **This is trap 1's regression check against a live database** — under a naive substring matcher this exact message opts Marcus out permanently.

```bash
echo "--- snooze ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/ingest-inbound \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_id\":\"$MARCUS\",\"body\":\"busy now, call me next month\"}"
echo
```

Expect `keyword_hit: "call me next month"` and a `snooze_until` ~30 days out.

```bash
echo "--- opt out ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/ingest-inbound \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"lead_id\":\"$MARCUS\",\"body\":\"pls stop messaging me\"}"
echo
```

Expect `opt_out_detected: true`, `keyword_hit: "stop messaging"`.

> `facts_refreshed` will be `0` on all three unless `ANTHROPIC_API_KEY` is set in `.env.local` — `extract-facts` needs a real key. That is expected and is not a failure of this task; the field is `0` and the error is logged (see the SPEC-GAP in Step 3).

### Verify the lead row

```bash
cd $REPO
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select name, state, opted_out, touch_count, snooze_until, last_inbound_at
   from leads where name='Marcus Tan';"
```

| Column | Expected | Why |
|---|---|---|
| `opted_out` | `t` | the third call |
| `touch_count` | `0` | §8 resets it on every inbound |
| `snooze_until` | set (~30d out) | from the second call; opt-out doesn't clear it |
| `last_inbound_at` | just now | §8 |
| **`state`** | **`new`** | **trap 3 — still the seed's placeholder. `ingest-inbound` must never write this.** |

That `state` column is the one to actually look at. If it says `do_not_contact`, this function is writing a column §6.1 reserves for `generate-drafts`, and task 4's guard test will fail.

### Verify error paths

```bash
cd $REPO
echo "--- missing body ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/ingest-inbound \
  -H 'Content-Type: application/json' -d '{"agent_id":"x","lead_id":"y"}' -w "\nHTTP %{http_code}\n"
echo "--- wrong agent for the lead ---"
curl -s -X POST http://127.0.0.1:54321/functions/v1/ingest-inbound \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"00000000-0000-0000-0000-000000000000\",\"lead_id\":\"$MARCUS\",\"body\":\"hi\"}" \
  -w "\nHTTP %{http_code}\n"
```

Expect `400` then `403`.

Then re-seed, so the deliberately opted-out Marcus doesn't leak into later tasks:

```bash
cd $REPO && pnpm seed
```

---

## Step 5 — full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0; `pnpm test` reports **166 tests**.

Optionally, if you have Docker and want the edge function typechecked too:

```bash
cd $REPO
docker run --rm -v "$(pwd)":/work -w /work --entrypoint deno denoland/deno:alpine-2.1.4 \
  check --config supabase/functions/deno.json supabase/functions/ingest-inbound/index.ts
```

**// SPEC-GAP: edge functions are still outside `pnpm typecheck`** — `supabase/` is not a pnpm workspace, the same gap tasks 8 and 9 documented. The mitigation is unchanged: all the logic lives in `keywords.ts`, which is typechecked and has 22 tests; `index.ts` is orchestration you exercise by calling it in Step 4.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `"can i stop by"` sets `opt_out_detected: true` | `stop` matched as a substring | Trap 1 — it is whole-message-only |
| `don’t message me` is not detected | Curly apostrophe not normalised | Trap 5 |
| `snooze_until` moves when you re-run with the same `sent_at` | `Date.now()` used instead of the injected `sentAt` | Trap 2 |
| `leads.state` changed to `do_not_contact` | The function wrote `state` | Trap 3 — remove it; §6.1 forbids it |
| Task 4's `leads.state` guard test fails | Same as above | Same |
| `facts_refreshed` always `0` | No `ANTHROPIC_API_KEY`, or extract-facts erroring | Expected without a key; check the logged `extract_facts_failed` line |
| `fetch failed` calling extract-facts | Used `127.0.0.1` instead of `SUPABASE_URL` | Trap 6 — it is `http://kong:8000` inside the runtime |
| `Module not found ".../packages/core/src/index.ts"` | Imported the `@revive/core` barrel | Amendment A6 — import `keywords.ts` by relative path |

---

## Step 6 — Acceptance and commit

### Checklist

- [ ] `detectKeywords` is pure, takes `sentAt`, and never calls `Date.now()`
- [ ] Both §6.2 lists transcribed verbatim and in order, with a test asserting it
- [ ] Every keyword in both lists has a test proving it actually fires
- [ ] 8 false-positive tests prove bare `stop` no longer matches in-sentence
- [ ] Curly apostrophe handled
- [ ] Opt-out beats snooze; only one `keyword_hit` reported, first in §6.2 order
- [ ] `+30` days default, `+60` for `next year` only
- [ ] `ingest-inbound` inserts the message, sets `last_inbound_at`, resets `touch_count = 0`
- [ ] **`leads.state` is never written** — verified by looking at the column after Step 4
- [ ] `agent_id`/`lead_id` mismatch returns 403
- [ ] `extract-facts` called last; its `inserted` becomes `facts_refreshed`; failure is logged, not fatal
- [ ] `pnpm typecheck`, `pnpm test` (166), `pnpm --filter @revive/web build` all exit 0
- [ ] Re-seeded after testing, so no lead is left opted out

### Expected tree

```
$REPO/
├── packages/core/src/
│   ├── keywords.ts               # new
│   ├── keywords.test.ts          # new
│   └── index.ts                  # edited: +./keywords.ts
└── supabase/functions/
    └── ingest-inbound/index.ts   # new
```

`supabase/functions/deno.json` does **not** change. No migration.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 10: ingest-inbound + opt-out/snooze detection"
```

Then update **Current state** in `CLAUDE.md` and add amendment **A7** below.

---

## Amendment A7 — for `CLAUDE.md`

> ### A7 — §6.2's bare `stop` is matched as a whole message, not a substring
>
> §6.2 says "lowercase and check for: `stop`, …". Read as a plain `includes()`, the bare `stop` entry fires on ordinary property chat — measured at 8 out of 8 realistic non-opt-out messages: *"can i stop by the showflat this weekend?"*, *"is there a bus stop nearby?"*, *"we can stop at 1.2m if the unit is good"*, *"i stopped looking at D15"*, and so on. Each one sets `opted_out = true`, which makes `classify()` return `do_not_contact` and `hard_suppress` (priority 100) silence the lead **permanently — nothing in the contract un-opts-out a lead.** The seed does not expose this: all 46 seeded messages produce exactly one hit either way.
>
> **Resolution:** `stop` matches only as an entire message (case- and punctuation-insensitive), which is the real SMS opt-out convention and the reading that stops §6.2's own separate `stop messaging` entry from being redundant. Every other keyword matches on digit-aware word boundaries. In-sentence opt-out intent is still caught by the longer phrases, so no entry in §6.2's list becomes unreachable. Eight regression tests in `keywords.test.ts` pin the false positives.
>
> Also settled here: curly apostrophes (`’`, what phone keyboards emit) are normalised to `'` before matching, or §6.2's straight-quoted `don't message` never fires on a real message. And a residual accepted false positive: `q1` still matches *"q1 facing units"*, a real stack/facing term. Left alone because a snooze **expires** — the failure self-corrects — whereas an opt-out does not. Note it in the README's limitations (task 17).

---

## Next

**Task 11 — `generate-drafts`**, the core deliverable. Orchestrates classify → selectStrategy → write (§7.2) → guardrail → toneCheck (§7.3), builds the full `trace` object per §8, and is the **only writer of `leads.state`** — which is the invariant this task was careful not to break. It also carries the pending-draft skip (`drafts_one_pending_per_lead`, §3) and the `now`-override guard.

§11 puts a checkpoint immediately after it: **freeze `extract-v1`, `write-v1`, `tone-v1`** — no prompt edits until task 16, or the planted regression has no stable baseline to demo against.

**`0005_approve_draft.sql`** (amendment A1) is still outstanding and must land before task 13.

Two things carry over from here:

- **Kelvin Ong's seeded `opted_out = true`** was set directly by the seed because this function didn't exist yet. His final inbound (*"pls stop messaging me, already bought"*) is the natural end-to-end test for it, and F05 (task 12) asserts the same behaviour through the fixture path.
- **Snooze feeds `selectStrategy`'s `snoozed` rule** (priority 95, §6.3), which suppresses on `snooze_until > now`. F07 is the fixture for it.
