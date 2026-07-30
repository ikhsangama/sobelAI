# Task 8 — `supabase/seed/seed.ts`

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 8:

> `seed/seed.ts`: 2 agents (the second with a contrasting voice profile, so task 12's two-voice fixture has something real to run against), 6 leads across states (cold-with-gap, cold-complete, new-ad, warm-already-messaged, opted-out, dormant) under the first agent, ~40 messages total in the fixture voice. Reuse one lead+thread under the second agent for the voice-contrast fixture.

**Outcome:** a local database you can actually demo against. Every task from 9 onward — `extract-facts`, `generate-drafts`, the queue UI — runs against these rows. Get the six states right and everything downstream has something real to work on; get them wrong and you debug the wrong layer for an hour.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `lead_facts` rows | Task 9 (`extract-facts`) — **see Trap 3, this one matters** |
| `drafts` rows | Task 11 (`generate-drafts`) |
| Eval fixtures (`packages/eval/fixtures/*.json`) | Task 12 — separate from this seed, though the two-voice pair originates here |
| `0004_approve_draft.sql` | Still outstanding; amendment A1 allows it any time before task 13 |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

---

## Read this before you start

### Six traps

**Trap 1 — every timestamp is relative to run time. Never hardcode a date.**
This is the one that silently rots. The six leads are defined *by their day-offsets*: "cold" means `classify()` sees an inbound 8–45 days old, "dormant" means older than 45. Hardcode `2026-07-09` and the cold lead is still cold today, cold next week, and **dormant** in two months — at which point `gap_fill` stops firing, F01 goes red, and nothing in the code changed. Every date below is computed as `now - N days`. The `ago()` helper exists for exactly this and there is no reason to bypass it.

**Trap 2 — the new-ad lead has ZERO messages, and that is deliberate.**
`classify()` (§6.1) returns `'new'` only when `touch_count === 0 && last_inbound_at === null && daysSinceCreated <= 2`. **`last_inbound_at` must be null**, so the lead cannot have an inbound message. Add one "to make the thread look realistic" and the lead silently becomes `warm`, `new_ad_lead` never fires, and you've broken F03 and the seeded half of amendment A4's documented reachability gap. A Meta ad lead whose form submission hasn't arrived as a message is a real state, not a gap in the data. Leave it empty.

**Trap 3 — do NOT insert `lead_facts`. Not one row.**
It is tempting: "cold-with-gap" and "cold-complete" differ by whether all four `REQUIRED_FOR_QUALIFIED` facts exist, so why not just insert them? Because §5's evidence rule — *"Every `lead_facts` row must have a non-empty `evidence` string that appears verbatim as a substring of the body of `source_message_id`"* — is the single most important correctness property in this repo, and hand-written facts are precisely the fabricated-evidence case it exists to reject. Facts are produced by `extract-facts` (task 9) from the message threads seeded here, or they are not trustworthy. The difference between the two cold leads lives **in their message bodies**: Marcus's thread never states a timeline, Priya's says *"hoping to move in the next 3 months"*. That's what makes one a gap and the other complete.

**Trap 4 — `leads.state` written here is a placeholder and means nothing.**
§6.1: `leads.state` is a denormalized cache whose **only** writer is `generate-drafts`. The seed sets `'new'` on every row purely because the column is `not null`. Do not try to pre-compute the real state into it — the self-check at the bottom of the script calls `classify()` directly, which is the actual source of truth.

**Trap 5 — Node cannot import the `@revive/core` barrel. Import the leaf file by path.**
`import { classify } from '@revive/core'` fails with `ERR_MODULE_NOT_FOUND`: the barrel re-exports `'./types'` extensionless, which `moduleResolution: "bundler"` allows but Node's ESM loader does not — the same limitation tasks 5, 6 and 7 hit. `../../packages/core/src/classify.ts` **does** work, because that file's only import is `import type`, which type-stripping erases completely. Verified, not assumed.

**Trap 6 — the seed uses the service role, which bypasses RLS. That is correct.**
Task 2 proved the policies block anon and admit service-role. Seeding is a service-role job by definition. If you find yourself debugging an RLS denial here, you're using the wrong key — check `SUPABASE_SERVICE_ROLE_KEY`, not the anon key.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Local Supabase must be running (`supabase start`) before Step 4.

---

## Step 1 — root `package.json`

The seed needs two things the repo doesn't have yet: a Supabase client resolvable from the repo root, and a script to run it.

Add `@supabase/supabase-js` to **root** `devDependencies` (it currently exists only in `apps/web/node_modules`, which `supabase/seed/seed.ts` cannot reach — pnpm's layout is strict), and add the `seed` script:

```json
  "scripts": {
    "dev": "pnpm --filter @revive/web dev",
    "build": "pnpm --filter @revive/web build",
    "test": "vitest run",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "eval": "pnpm --filter @revive/eval start",
    "seed": "node --env-file-if-exists=.env.local supabase/seed/seed.ts"
  },
  "devDependencies": {
    "@supabase/supabase-js": "^2.111.0",
    "typescript": "~6.0.2",
    "vitest": "^4.0.0"
  }
```

Then:

```bash
cd $REPO && pnpm install
```

Three notes on that script line:

- **`node` runs the `.ts` file directly.** Node 22.19 strips types natively; no `tsx`, no build step, no new toolchain. It strips without *checking* — see the SPEC-GAP note in Step 6.
- **`--env-file-if-exists`, not `--env-file`.** With the plain flag, a fresh clone that hasn't created `.env.local` dies on `node: .env.local: not found`, which tells you nothing. With `-if-exists`, the script's own error fires instead and tells you exactly which variable to set and where to get it.
- **This is a script, not a `supabase db reset` hook.** Amendment A3: `db.seed.enabled = false`, because `config.toml` shipped pointing at a `seed.sql` that does not exist.

## Step 2 — environment

The seed needs the service-role key, which is not in `.env.local` yet. Add it to **`.env.local.example`** (committed, no value) and **`.env.local`** (real value, gitignored):

```bash
# Server-side ONLY. Never prefix with VITE_.
SUPABASE_SERVICE_ROLE_KEY=
```

Get the local value from:

```bash
cd $REPO && supabase status -o json
```

Use the `SERVICE_ROLE_KEY` field. It's the standard non-secret local development key — the same one on every local Supabase install — but keep the habit of not prefixing it `VITE_`, because the identically-named production key would ship straight to the browser.

---

## Step 3 — `supabase/seed/seed.ts`

Create the file with exactly this content.

```ts
import { createClient } from '@supabase/supabase-js'
import type { LeadRow } from '../../packages/core/src/types.ts'
import { classify } from '../../packages/core/src/classify.ts'

/**
 * Local demo data. Run with `pnpm seed`.
 *
 * Everything here is relative to NOW (trap 1). The six leads under the first
 * agent are defined by their distance from `now`, not by calendar dates, so
 * the seed produces the same six states whenever it runs.
 *
 * // SPEC-GAP: §11 says "~40 messages total in the fixture voice" and lists
 * six lead descriptors but specifies no message bodies. These are written in
 * the style §10 asks for — realistic, lowercase, typo-ridden Singapore
 * property chat — and the two cold threads are deliberately differentiated by
 * whether a timeline is ever stated (see trap 3).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. Get it from `supabase status -o json`.')
}
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** `SEED_NOW` lets the eval harness (task 12) pin a run to a fixed instant. */
const NOW = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date()
if (Number.isNaN(NOW.getTime())) throw new Error('SEED_NOW is not a valid date')
const DAY = 86_400_000

/** N days before NOW, at a given SGT hour. Trap 1 — never hardcode a date. */
const ago = (days: number, sgtHour = 10) => {
  const d = new Date(NOW.getTime() - days * DAY)
  d.setUTCHours(sgtHour - 8, 5, 0, 0)
  return d.toISOString()
}

const AGENT_NAMES = ['Wei Ling', 'Terence Koh']

/**
 * Two voices. §9 cut the `/settings` route, so this contrast is the whole
 * mechanism behind §12's "same lead + two voice profiles produces two visibly
 * different drafts" checkbox. Wei Ling matches the fixture voice in §10;
 * Terence Koh is deliberately her opposite on every axis that matters.
 */
const AGENTS = [
  {
    name: 'Wei Ling',
    max_touches: 4,
    quiet_hours_start: 9,
    quiet_hours_end: 20,
    voice_profile: {
      formality: 2,
      warmth: 4,
      brevity: 4,
      emoji_ok: false,
      sign_off: '- Wei Ling',
      sample_messages: [
        'hey Marcus! just saw a 3 bedder in katong that might work for u, want me to send?',
        'no worries, take ur time. shout when ready ya',
        'ok noted! ill keep a lookout for D15 under 1.5m',
      ],
    },
  },
  {
    name: 'Terence Koh',
    max_touches: 4,
    quiet_hours_start: 9,
    quiet_hours_end: 20,
    voice_profile: {
      formality: 5,
      warmth: 2,
      brevity: 1,
      emoji_ok: false,
      sign_off: 'Best regards,\nTerence Koh',
      sample_messages: [
        'Good afternoon Mr Marcus. I trust this message finds you well. I am writing to inform you that a three-bedroom unit has become available in the Katong vicinity.',
        'Thank you for your response. Please do not hesitate to contact me should you require any further clarification on the matter.',
        'Noted with thanks. I shall revert to you once I have compiled a suitable shortlist for your consideration.',
      ],
    },
  },
]

type SeedMsg = { direction: 'inbound' | 'outbound'; days: number; hour: number; body: string }
type SeedLead = {
  key: string
  /** What classify() must return for this lead. Asserted at the end of main(). */
  expect: string
  name: string
  phone: string
  source: string
  touch_count: number
  inboundDays: number | null
  outboundDays: number | null
  createdDays: number
  opted_out?: boolean
  messages: SeedMsg[]
}

const LEADS: SeedLead[] = [
  {
    // cold + a fact gap: budget, district and bedrooms are all stated, but
    // nobody ever mentions a timeline -> factGaps() returns ['timeline']
    // once task 9 extracts, so gap_fill (60) wins over listing_hook (50).
    key: 'cold_with_gap',
    expect: 'cold',
    name: 'Marcus Tan',
    phone: '+6591230001',
    source: 'propertyguru',
    touch_count: 1,
    inboundDays: 21,
    outboundDays: 20,
    createdDays: 40,
    messages: [
      { direction: 'inbound', days: 40, hour: 21, body: 'hi saw ur listing on pg, still available ah' },
      { direction: 'outbound', days: 40, hour: 21, body: 'Hi Marcus! yes still available. what are u looking for?' },
      { direction: 'inbound', days: 39, hour: 9, body: 'looking at katong area, budget around 1.5m for a 3 bedder' },
      { direction: 'outbound', days: 39, hour: 10, body: 'noted! D15 3 bedders around that range, i have a few. own stay or invest?' },
      { direction: 'inbound', days: 39, hour: 12, body: 'own stay, me n my wife' },
      { direction: 'outbound', days: 30, hour: 11, body: 'hey Marcus, 2 new units came up in D15. want me to send the details?' },
      { direction: 'inbound', days: 21, hour: 20, body: 'ya can send, sorry been busy' },
      { direction: 'outbound', days: 20, hour: 10, body: 'sent to ur email! let me know what u think' },
    ],
  },
  {
    // cold + complete: all four REQUIRED_FOR_QUALIFIED facts are stated in the
    // thread (buy / 1.2m / D19 / "next 3 months"), so there is no gap and
    // listing_hook (50) is the highest rule left standing.
    key: 'cold_complete',
    expect: 'cold',
    name: 'Priya Nair',
    phone: '+6591230002',
    source: '99co',
    touch_count: 1,
    inboundDays: 21,
    outboundDays: 20,
    createdDays: 50,
    messages: [
      { direction: 'inbound', days: 50, hour: 14, body: 'hi, saw the serangoon listing on 99co' },
      { direction: 'outbound', days: 50, hour: 15, body: 'Hi Priya! thanks for reaching out. buying or renting?' },
      { direction: 'inbound', days: 49, hour: 10, body: 'buying. budget max 1.2m, looking at D19 only' },
      { direction: 'outbound', days: 49, hour: 11, body: 'got it. how many bedrooms u need?' },
      { direction: 'inbound', days: 49, hour: 13, body: '3 bedroom. hoping to move in the next 3 months' },
      { direction: 'outbound', days: 49, hour: 14, body: 'perfect, thats doable in D19 at 1.2m. ill shortlist some' },
      { direction: 'inbound', days: 45, hour: 9, body: 'ok thanks' },
      { direction: 'outbound', days: 40, hour: 16, body: 'hi Priya, 3 units in D19 that fit. sending now' },
      { direction: 'inbound', days: 21, hour: 19, body: 'sorry just saw this, still looking ya' },
      { direction: 'outbound', days: 20, hour: 10, body: 'no problem! ill keep u posted on new D19 launches' },
    ],
  },
  {
    // TRAP 2. Zero messages, on purpose. classify() returns 'new' only when
    // last_inbound_at is null; one inbound message flips this lead to 'warm'
    // and new_ad_lead (75) stops firing. Do not "fix" this by adding a thread.
    key: 'new_ad',
    expect: 'new',
    name: 'Jonathan Lim',
    phone: '+6591230003',
    source: 'meta_ad',
    touch_count: 0,
    inboundDays: null,
    outboundDays: null,
    createdDays: 1,
    messages: [],
  },
  {
    // warm + already touched -> warm_human_handles (80) suppresses. This is
    // the product's core promise as a rule: the AI stays out of a live
    // conversation the agent is already having.
    key: 'warm_handled',
    expect: 'warm',
    name: 'Siti Rahman',
    phone: '+6591230004',
    source: 'referral',
    touch_count: 2,
    inboundDays: 2,
    outboundDays: 1,
    createdDays: 30,
    messages: [
      { direction: 'inbound', days: 30, hour: 11, body: 'hi, my colleague gave me ur number. looking to rent' },
      { direction: 'outbound', days: 30, hour: 12, body: 'Hi Siti! sure. which area and whats ur budget?' },
      { direction: 'inbound', days: 29, hour: 9, body: 'tampines or pasir ris, around 3.5k a month' },
      { direction: 'outbound', days: 29, hour: 10, body: 'ok noted. 2 or 3 bedder?' },
      { direction: 'inbound', days: 29, hour: 15, body: '3 bedder, moving in sept' },
      { direction: 'outbound', days: 10, hour: 11, body: 'hi Siti, a few 3 bedders in tampines came up. free to view this wkend?' },
      { direction: 'inbound', days: 2, hour: 20, body: 'yes im keen! sat afternoon can?' },
      { direction: 'outbound', days: 1, hour: 10, body: 'sat 2pm works! ill confirm the unit and revert' },
    ],
  },
  {
    // opted out -> do_not_contact -> hard_suppress (100). The final inbound
    // carries two §6.2 keywords ("stop messaging" and "already bought"), which
    // is what task 10's ingest-inbound will detect. opted_out is set directly
    // here because that function does not exist yet.
    key: 'opted_out',
    expect: 'do_not_contact',
    name: 'Kelvin Ong',
    phone: '+6591230005',
    source: 'propertyguru',
    touch_count: 1,
    inboundDays: 5,
    outboundDays: 6,
    createdDays: 35,
    opted_out: true,
    messages: [
      { direction: 'inbound', days: 35, hour: 13, body: 'hi enquiring about the bedok unit' },
      { direction: 'outbound', days: 35, hour: 14, body: 'Hi Kelvin! its still available. keen to view?' },
      { direction: 'inbound', days: 34, hour: 10, body: 'let me think first' },
      { direction: 'outbound', days: 20, hour: 11, body: 'hi Kelvin, just checking if ure still looking?' },
      { direction: 'outbound', days: 6, hour: 10, body: 'hi Kelvin, new bedok listing came up, keen?' },
      { direction: 'inbound', days: 5, hour: 18, body: 'pls stop messaging me, already bought' },
    ],
  },
  {
    // 60 days silent -> dormant -> long_dormant (30) / market_update.
    key: 'dormant',
    expect: 'dormant',
    name: 'Rachel Goh',
    phone: '+6591230006',
    source: 'manual',
    touch_count: 1,
    inboundDays: 60,
    outboundDays: 59,
    createdDays: 90,
    messages: [
      { direction: 'inbound', days: 90, hour: 16, body: 'hi, met u at the queenstown showflat last wkend' },
      { direction: 'outbound', days: 90, hour: 17, body: 'Hi Rachel! good to hear from u. still considering the 2 bedder?' },
      { direction: 'inbound', days: 89, hour: 11, body: 'ya but waiting for my hdb to sell first' },
      { direction: 'outbound', days: 89, hour: 12, body: 'understood! ping me when its sold, ill line up some viewings' },
      { direction: 'inbound', days: 60, hour: 15, body: 'still not sold yet, market quite slow' },
      { direction: 'outbound', days: 59, hour: 10, body: 'no worries Rachel, ill check in again in a bit' },
    ],
  },
]

/**
 * The lead mirrored under the second agent. Same thread, same timings,
 * different voice profile — which is exactly the input task 12's two-voice
 * fixture needs to print two drafts side by side.
 */
const VOICE_CONTRAST_KEY = 'cold_with_gap'

async function main() {
  console.log(`Seeding against ${SUPABASE_URL}`)
  console.log(`now = ${NOW.toISOString()}`)

  // Idempotent: `pnpm seed` twice must not produce twelve leads. Deleting the
  // agents cascades to leads -> messages / lead_facts / drafts (§3).
  const { error: delErr } = await db.from('agents').delete().in('name', AGENT_NAMES)
  if (delErr) throw new Error(`clearing previous seed failed: ${delErr.message}`)

  const { data: agents, error: agentErr } = await db.from('agents').insert(AGENTS).select('id, name')
  if (agentErr || !agents) throw new Error(`inserting agents failed: ${agentErr?.message}`)
  const agentId: Record<string, string> = Object.fromEntries(agents.map((a) => [a.name, a.id]))
  console.log(`  agents: ${agents.map((a) => a.name).join(', ')}`)

  let messageCount = 0
  const inserted: { key: string; id: string; expect: string }[] = []

  for (const [i, spec] of LEADS.entries()) {
    const targets = [{ agent: 'Wei Ling', suffix: '' }]
    if (spec.key === VOICE_CONTRAST_KEY) targets.push({ agent: 'Terence Koh', suffix: ' (voice B)' })

    for (const t of targets) {
      const aid = agentId[t.agent]!
      const { data: lead, error: leadErr } = await db
        .from('leads')
        .insert({
          agent_id: aid,
          name: spec.name + t.suffix,
          phone: t.suffix ? spec.phone.replace(/\d$/, String(9 - i)) : spec.phone,
          source: spec.source,
          // Trap 4: placeholder only. generate-drafts owns this column.
          state: 'new',
          qualification_status: 'unqualified',
          last_inbound_at: spec.inboundDays === null ? null : ago(spec.inboundDays, 20),
          last_outbound_at: spec.outboundDays === null ? null : ago(spec.outboundDays, 10),
          touch_count: spec.touch_count,
          opted_out: spec.opted_out ?? false,
          created_at: ago(spec.createdDays, 9),
        })
        .select('id')
        .single()
      if (leadErr || !lead) throw new Error(`inserting lead ${spec.key} failed: ${leadErr?.message}`)

      if (spec.messages.length) {
        const rows = spec.messages.map((m) => ({
          lead_id: lead.id,
          agent_id: aid,
          direction: m.direction,
          body: m.body,
          sent_at: ago(m.days, m.hour),
          provider: 'mock',
          provider_msg_id: `seed-${spec.key}${t.suffix ? '-b' : ''}-${m.days}-${m.hour}`,
        }))
        const { error: msgErr } = await db.from('messages').insert(rows)
        if (msgErr) throw new Error(`inserting messages for ${spec.key} failed: ${msgErr.message}`)
        messageCount += rows.length
      }
      if (!t.suffix) inserted.push({ key: spec.key, id: lead.id, expect: spec.expect })
    }
  }

  console.log(`  leads: ${LEADS.length} under Wei Ling + 1 mirrored under Terence Koh`)
  console.log(`  messages: ${messageCount}`)

  // The whole point of this seed is "6 leads across states". Prove it with the
  // real classify() against the rows actually stored, rather than trusting the
  // day-offsets above to still mean what they meant when they were written.
  const { data: check, error: checkErr } = await db
    .from('leads')
    .select('*')
    .in('id', inserted.map((l) => l.id))
  if (checkErr || !check) throw new Error(`re-reading leads failed: ${checkErr?.message}`)

  const byId = new Map(check.map((l) => [l.id, l]))
  let failures = 0
  console.log('\n  state check (classify() on the rows actually stored):')
  for (const { key, id, expect } of inserted) {
    const actual = classify(byId.get(id) as unknown as LeadRow, NOW)
    const ok = actual === expect
    if (!ok) failures++
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(16)} expected ${expect.padEnd(15)} got ${actual}`)
  }
  if (failures) throw new Error(`${failures} lead(s) did not classify as intended`)
  console.log('\nSeed complete.')
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`)
  process.exit(1)
})
```

### Why the self-check is the important part

Six day-offsets encode six states through `classify()`'s boundaries at 2, 7 and 45 days. Nothing about `inboundDays: 21` says "cold" on its face — you have to run it. So the script re-reads what it wrote and asserts `classify(lead, NOW) === expect` for all six, and exits non-zero if any disagree. That turns the seed's central claim from a comment into something the machine checks on every run. Step 5 proves it isn't vacuous.

---

## Step 4 — run it

```bash
cd $REPO
supabase start           # if not already running
pnpm seed
```

Expected output (the `now` line will differ):

```
Seeding against http://127.0.0.1:54321
now = 2026-07-30T19:23:10.453Z
  agents: Wei Ling, Terence Koh
  leads: 6 under Wei Ling + 1 mirrored under Terence Koh
  messages: 46

  state check (classify() on the rows actually stored):
    ok   cold_with_gap    expected cold            got cold
    ok   cold_complete    expected cold            got cold
    ok   new_ad           expected new             got new
    ok   warm_handled     expected warm            got warm
    ok   opted_out        expected do_not_contact  got do_not_contact
    ok   dormant          expected dormant         got dormant

Seed complete.
```

**46 messages** = 38 under Wei Ling (§11's "~40") + 8 in the mirrored Terence Koh thread.

### Verify

Run it twice more and confirm the counts don't move — this is the idempotency check:

```bash
cd $REPO
pnpm seed > /dev/null && pnpm seed > /dev/null && echo "reran twice, ok"
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select (select count(*) from agents)||' agents, '||(select count(*) from leads)||' leads, '||(select count(*) from messages)||' messages';"
```

Expected: `2 agents, 7 leads, 46 messages` — unchanged no matter how many times you run it.

Then eyeball the distribution:

```bash
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c "
select a.name as agent, l.name as lead, l.source, l.touch_count, l.opted_out, count(m.id) as msgs
from leads l join agents a on a.id=l.agent_id
left join messages m on m.lead_id=l.id
group by a.name, l.name, l.source, l.touch_count, l.opted_out, l.created_at
order by a.name desc, l.created_at;"
```

```
    agent    |         lead         |    source    | touch_count | opted_out | msgs
-------------+----------------------+--------------+-------------+-----------+------
 Wei Ling    | Rachel Goh           | manual       |           1 | f         |    6
 Wei Ling    | Priya Nair           | 99co         |           1 | f         |   10
 Wei Ling    | Marcus Tan           | propertyguru |           1 | f         |    8
 Wei Ling    | Kelvin Ong           | propertyguru |           1 | t         |    6
 Wei Ling    | Siti Rahman          | referral     |           2 | f         |    8
 Wei Ling    | Jonathan Lim         | meta_ad      |           0 | f         |    0
 Terence Koh | Marcus Tan (voice B) | propertyguru |           1 | f         |    8
```

`Jonathan Lim` showing `0` messages is correct — that's trap 2, not a bug.

---

## Step 5 — prove the self-check can actually fail

A green check you've never seen go red is not evidence. Plant a violation, watch it fire, then put it back. (Tasks 4 and 5 did the same thing for their guard tests.)

```bash
cd $REPO
# Make the dormant lead 20 days silent instead of 60 -> it should become cold.
sed -i "s/    inboundDays: 60,/    inboundDays: 20,/" supabase/seed/seed.ts
pnpm seed > /dev/null 2>&1; echo "exit code with planted violation: $?"
```

Expected: **`exit code with planted violation: 1`**, and running it without redirecting shows:

```
    FAIL dormant          expected dormant         got cold

Seed failed: 1 lead(s) did not classify as intended
```

Restore it and confirm green again:

```bash
cd $REPO
sed -i "s/    inboundDays: 20,/    inboundDays: 60,/" supabase/seed/seed.ts
grep -c "inboundDays: 60," supabase/seed/seed.ts    # must print exactly 1
pnpm seed > /dev/null 2>&1; echo "exit code restored: $?"
```

Expected: `1`, and `exit code restored: 0`.

The restore pattern is safe because after planting there is exactly one `inboundDays: 20,` in the file. Note it has **no `\n`** in it — `sed` works line by line and a `\n` in the pattern matches nothing, so the substitution would silently no-op and leave the planted violation in place.

> If `sed` still doesn't restore cleanly, edit the `dormant` block by hand — `inboundDays` must be `60` and `outboundDays` must be `59`. Do not leave the planted value in.

**Note the pipe hazard:** `pnpm seed | tail -5; echo $?` reports `tail`'s exit code, not the seed's, and will print `0` even on failure. Check the exit code without a pipe, as above.

---

## Step 6 — full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0, and all three should be **unaffected** — this task adds no workspace source. `pnpm test` is still 7 files / 128 tests.

**// SPEC-GAP: `supabase/seed/seed.ts` is not typechecked.** `pnpm typecheck` runs `tsc` per workspace package, and `supabase/` is not a workspace (`pnpm-workspace.yaml` globs only `apps/*` and `packages/*`). Node strips the types without checking them, so a type error here fails silently rather than at build time. Accepted rather than designed around: adding a tsconfig and a workspace entry for one dev script is more machinery than the risk warrants, and the self-check in Step 5 catches the errors that actually matter (wrong states) — which a typechecker would not have caught anyway. If `supabase/functions/` later wants the same treatment, revisit it then.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY is not set` | Step 2 skipped, or `.env.local` missing the line | `supabase status -o json` → copy `SERVICE_ROLE_KEY` |
| `Cannot find package '@supabase/supabase-js'` | Not added to **root** devDependencies (it's in `apps/web` only) | Step 1, then `pnpm install` |
| `ERR_MODULE_NOT_FOUND` ending in `/packages/core/src/types` | You imported the `@revive/core` barrel | Trap 5 — import `../../packages/core/src/classify.ts` directly |
| `FAIL new_ad expected new got warm` | A message was added to the Meta ad lead | Trap 2 — it must have zero messages and `last_inbound_at: null` |
| `FAIL <lead> expected cold got dormant` | A hardcoded date crept in, or offsets were edited | Trap 1 — everything goes through `ago()` |
| `insert or update on table "leads" violates foreign key` | Agent insert failed but the error wasn't checked | Confirm the `agents` insert returned rows |
| Twelve leads instead of seven | The delete-first block was dropped | It's what makes `pnpm seed` idempotent; restore it |
| `node: .env.local: not found` | Script uses `--env-file` instead of `--env-file-if-exists` | Step 1 |

---

## Step 7 — Acceptance and commit

### Checklist

- [ ] Two agents with genuinely contrasting voice profiles (formality 2/5, warmth 4/2, brevity 4/1)
- [ ] Six leads under Wei Ling covering cold-with-gap, cold-complete, new-ad, warm-already-messaged, opted-out, dormant
- [ ] One lead + thread mirrored under Terence Koh for the two-voice fixture
- [ ] ~40 messages in the fixture voice (38 under agent 1, 46 total)
- [ ] Every timestamp derived from `now` via `ago()` — zero hardcoded dates
- [ ] The Meta ad lead has zero messages and `last_inbound_at: null`
- [ ] **No `lead_facts` rows inserted** — facts come from `extract-facts` in task 9
- [ ] The self-check asserts all six states with the real `classify()` and exits 1 on mismatch
- [ ] Proven non-vacuous by planting a violation (Step 5) and restoring
- [ ] `pnpm seed` is idempotent — three runs give `2 agents, 7 leads, 46 messages`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all still exit 0

### Expected tree

```
$REPO/
├── package.json               # edited: +@supabase/supabase-js (dev), +seed script
├── .env.local.example         # edited: +SUPABASE_SERVICE_ROLE_KEY
└── supabase/seed/seed.ts      # new
```

Nothing under `packages/`, `apps/`, or `supabase/migrations/` changes.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 8: seed 2 agents, 6 leads, 46 messages"
```

Then update **Current state** in `CLAUDE.md` to task 8 complete.

---

## Next

Two things are now open, and they're independent:

**`0004_approve_draft.sql`** (amendment A1) has been unblocked since task 7 and must land before task 13. §8 specifies it: quiet-hours check (SGT hour within `[quiet_hours_start, quiet_hours_end)`, else 409 `outside_quiet_hours`), the mock send, the outbound `messages` insert, and `touch_count += 1` / `last_outbound_at` / `resolved_at` / `status` — all in one transaction, which is the entire reason it isn't a client-side `PATCH`. The plpgsql function generates the `provider_msg_id` itself; `MockProvider` (task 7) is the TypeScript-side seam, not something SQL calls.

**Task 9 — `extract-facts`**, the next contract task and the first edge function. It runs against the threads seeded here: prompt §7.1, plus the four-layer evidence enforcement from §5 — verbatim substring check, server-side validation, the ±2% numeric cross-check on `budget_min`/`budget_max`/`bedrooms`, and superseding via `superseded_at`. §11 says to test it on all six seeded leads and confirm both an `evidence_mismatch` and a `value_evidence_mismatch` rejection are reachable by stubbing.

Two things to know going in:

- **The Meta ad lead has no messages**, so extraction over it must insert zero facts and *not* error. That's a real case worth asserting, not an edge case to skip.
- **Marcus's thread has no timeline and Priya's does.** That difference is the entire mechanism separating `gap_fill` from `listing_hook` at task 11 — if extraction invents a timeline for Marcus, the seeded distinction collapses and F01 turns red for a reason that has nothing to do with `selectStrategy`.
