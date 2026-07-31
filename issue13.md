# Task 13 — `/queue`, `DraftCard`, approve / edit / skip

> **§11 task 13:** `/queue` + `DraftCard` + approve/edit/skip mutations (approve calls `approve_draft`, §8) + `Run cadence tick`.

The first UI task. Everything before this was backend — you now build the operator screen that
makes it visible: a list of drafts awaiting approval, each showing who the lead is, why this
draft exists, and what it says, with buttons to send it, edit-then-send it, or skip it.

This task also finally lands **`0005_approve_draft.sql`**, the migration amendment A1 has been
deferring since task 2. Approve cannot be built without it.

**Scope boundary.** You are building **one route** (`/queue`). `/leads/:id` is task 14.
`TracePanel` is task 15. Do not build them here. Do not add auth UI, settings, dark mode, or a
landing page.

---

## Read this before you start

Everything in this brief has been run against the live local database before being written down.
Where it says "verified", that means a command was executed and its output checked — not that it
looks right.

### Eight traps

Each of these was hit for real while preparing this brief. They are in the order you will meet them.

---

**Trap 1 — the anon key reads zero drafts, and does not tell you why.**

`0002_rls.sql` puts a `tenant_isolation` policy on `drafts`, `leads`, `messages` and `lead_facts`:

```sql
using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
```

The browser client currently uses `VITE_SUPABASE_ANON_KEY`. The anon JWT carries **no `agent_id`
claim**, so that expression is `agent_id = NULL`, which is `NULL`, which is not `true` — every row
is filtered out. Verified live: a draft row was inserted with the service role, then read back
with each key.

```
--- inserting probe draft as service role
[{"id":"537a22c9-...","lead_id":"99d4554d-...","body":"probe draft for RLS test", ...}]
--- ANON read drafts:
[]
--- SERVICE read drafts:
[{"id":"537a22c9-...","body":"probe draft for RLS test"}]
```

Note the failure shape: PostgREST returns **HTTP 200 with an empty array**, not a 401 and not an
error. If you build the whole queue page against the anon key you will get a blank screen, a green
network tab, and nothing at all to debug.

**Resolution — this is already decided, do not redesign it.** §12's definition-of-done says
literally:

> RLS policies exist on all tenant tables; README states plainly that they ship but are **not
> exercised by the demo** (service-role + hardcoded `agent_id`)

So: the browser client uses the **service-role key** locally, and task 17's README says so plainly.
Step 3 does this. The alternative (minting a dev JWT with an `agent_id` claim) is a real option but
it is not the one the contract picked, and picking it here would quietly change what the README has
to say.

---

**Trap 2 — importing `@revive/core` from the web app breaks `tsc -b` today.**

`apps/web/tsconfig.app.json` sets `"erasableSyntaxOnly": true`. `packages/core/src/mockProvider.ts`
uses a TypeScript **parameter property**, which is not erasable syntax:

```ts
constructor(private readonly newId: () => string = () => `mock-${crypto.randomUUID()}`) {}
```

`@revive/core`'s only export is the barrel `./src/index.ts`, which re-exports `mockProvider.ts`. So
the moment `DraftCard.tsx` does `import { diffDays } from '@revive/core'`, the whole barrel is
typechecked and the build dies. Verified — this is a real build, not a guess:

```
../../packages/core/src/mockProvider.ts(23,15): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @revive/web@0.0.0 build: `tsc -b && vite build`
```

Step 2 fixes it in `mockProvider.ts` (a field + an assignment — three lines, no behaviour change),
because `packages/core` is explicitly meant to be consumed **as raw source** by both Deno and Vite.
Making it erasable-clean is the right fix; do not turn `erasableSyntaxOnly` off in the web app.

Verified after the fix: `pnpm --filter @revive/web build` succeeds and `pnpm test` still reports
202 passing.

---

**Trap 3 — outside 09:00–20:00 SGT, every approve returns 409, and your code is fine.**

§8 step 1 of `approve_draft` is the quiet-hours check, using the agent's
`quiet_hours_start`/`quiet_hours_end` (defaults `9` and `20`, SGT, start inclusive / end exclusive).
This brief was written at SGT hour **8**, and every approve correctly failed:

```
--- SGT hour 8, quiet hours [9,20) -> expect 409:
{"code":"PT409","details":"{\"quiet_hours_start\" : 9, \"quiet_hours_end\" : 20, \"sgt_hour\" : 8}",
 "hint":null,"message":"outside_quiet_hours"}
HTTP 409
```

This is correct behaviour, not a bug. You must test **both** branches. To reach the success path:

```bash
docker exec supabase_db_revive psql -U postgres -c \
  "update agents set quiet_hours_start = 0, quiet_hours_end = 24;"
```

and to force the 409 back for the negative test:

```bash
docker exec supabase_db_revive psql -U postgres -c \
  "update agents set quiet_hours_start = 9, quiet_hours_end = 20;"
```

**Put the defaults back (9 / 20) before you commit.** A widened window left in the database is
invisible in `git status` and will make the next person's negative test silently pass.

---

**Trap 4 — `approve_draft` returns an array, not an object.**

The function is `returns table (message_id uuid, provider_msg_id text)`, so PostgREST sends back a
**one-element array**. Verified:

```
[{"message_id":"b8c9ef3d-...","provider_msg_id":"mock-f9114bee-..."}]
HTTP 200
```

`supabase.rpc('approve_draft', ...)` therefore gives you `data[0]`, not `data`. `.single()` also
works. §8 documents the response as a bare object — that is the shape of the row, not of the HTTP
body.

---

**Trap 5 — the UI must never write `leads.state`.**

§6.1: `leads.state` is a denormalized cache and `generate-drafts` is its **only** writer anywhere
in the system. Task 4 has a test that fails if anything else writes it. Skip changes
`drafts.status` and `drafts.resolved_at` and nothing else. Approve changes cadence state
(`touch_count`, `last_outbound_at`) **inside the plpgsql function**, never from the client.

---

**Trap 6 — resolve the draft or the next cadence tick skips the lead.**

`drafts_one_pending_per_lead` is a partial unique index on `status = 'pending'`, and
`generate-drafts` skips any lead that already has a pending draft (`outcome: "skipped"`,
`trace.skipped_reason: "existing_pending_draft"`). That is the idempotency §8 wants — clicking
"Run cadence tick" twice must not double the queue.

The consequence for you: a draft you "handled" but left at `status = 'pending'` blocks that lead
forever. Both mutations must move the status off `pending` **and** set `resolved_at`.

---

**Trap 7 — `noUnusedLocals` and `noUnusedParameters` are on.**

`apps/web/tsconfig.app.json` enables both. An import you added while sketching and no longer use is
a **build failure**, not a warning. `verbatimModuleSyntax` is also on, so every type-only import
must say `import type` — `import { DraftRow }` fails, `import type { DraftRow }` compiles.

---

**Trap 8 — Tailwind v4. There is no config file.**

No `tailwind.config.js`, no `postcss.config.js`, and if you are typing `@tailwind base;` you have
gone wrong. Theme tokens live as CSS variables in `apps/web/src/index.css`. Use ordinary utility
classes (`bg-neutral-50`, `border-amber-400`); the existing `Button` component is the only shadcn
component in the repo and it is all you need. **Do not run `pnpm dlx shadcn@latest add ...`** — it
reaches the network and rewrites `index.css`. Every component below is written out in full.

---

### Conventions

- Workspace packages are `@revive/web`, `@revive/core`, `@revive/llm`, `@revive/eval`.
- `@/` is aliased to `apps/web/src/` (both in `vite.config.ts` and `tsconfig.app.json`).
- Vite's `envDir` is the **repo root**, so `.env.local` at the root is what the browser reads.
- Anything genuinely unspecified gets a `// SPEC-GAP:` comment and the simplest option. Do not
  silently design.

---

## Step 1 — `supabase/migrations/0005_approve_draft.sql`

Amendment A1 in `CLAUDE.md` has been deferring this since task 2. It ships now because approve
cannot exist without it.

§8 requires four things to happen **atomically**, because a partial failure desyncs `touch_count`,
which feeds the `touch_cap` and `last_chance` rules in §6.3:

1. Quiet-hours check (moved off guardrail G4 — see §6.4)
2. `MockProvider.send()`
3. Insert the outbound message
4. `touch_count += 1`, `last_outbound_at = now()`, `resolved_at = now()`,
   `drafts.status = 'approved'` (or `'edited'` if the body differs)

plpgsql cannot call TypeScript, so step 2 mints the `provider_msg_id` inline — exactly as amendment
A1 and the comment block in `mockProvider.ts` already describe. `MockProvider` stays the TS-side
seam for edge functions and the eval harness.

Create the file with this content **verbatim**. It has been applied to the live database and every
branch below was exercised.

```sql
-- Task 13 / planning-overview.md §8 — approve_draft.
--
-- CLAUDE.md amendment A1: §8 specifies this as a Postgres function doing four
-- things atomically, step 2 being MockProvider.send(). plpgsql cannot invoke
-- TypeScript, so the mock send happens inline here (minting a provider_msg_id
-- is the whole job -- see packages/core/src/mockProvider.ts, whose send() is
-- deliberately pure). MockProvider remains the TS-side seam used by edge
-- functions and the eval harness.
--
-- Renumbered twice: 0003 went to strategy_rules (task 5), 0004 to
-- supersede_and_insert_fact (task 9 review round).
--
-- Why a function and not a client-side PATCH: a partial failure desyncs
-- touch_count, which feeds touch_cap and last_chance (§6.3). Same reasoning
-- 0004_supersede_fact.sql already applied to extract-facts.
--
-- NOT security definer, deliberately: called with invoker rights, so if a real
-- authenticated user ever calls it the tenant_isolation policies in 0002 still
-- apply. The demo calls it with the service role, which has BYPASSRLS anyway.
--
-- SPEC-GAP: §8 documents the quiet-hours failure as `res 409 { "error":
-- "outside_quiet_hours", "quiet_hours_start": 9, "quiet_hours_end": 20 }`.
-- PostgREST owns the error envelope, so the closest faithful mapping is its
-- `PTxxx` SQLSTATE convention: PT409 becomes HTTP 409 and the payload arrives
-- as {code, message, details, hint}. The reason string lands in `message` and
-- the two hour values in `details` as a JSON string. Verified against a live
-- request, not assumed.
create or replace function approve_draft(p_draft_id uuid, p_body text)
returns table (message_id uuid, provider_msg_id text)
language plpgsql
as $$
declare
  v_draft  drafts%rowtype;
  v_agent  agents%rowtype;
  v_hour   int;
  v_msg_id uuid;
  v_pmid   text;
  v_status draft_status;
begin
  -- FOR UPDATE: two operators approving the same card race otherwise.
  select * into v_draft from drafts where id = p_draft_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'draft_not_found';
  end if;

  -- Only an unresolved draft can be approved. Without this, a double-click
  -- sends the message twice and increments touch_count twice.
  if v_draft.status not in ('pending', 'needs_review') then
    raise sqlstate 'PT409' using message = 'draft_already_resolved',
      detail = json_build_object('status', v_draft.status)::text;
  end if;

  select * into v_agent from agents where id = v_draft.agent_id;

  -- §8 step 1 — quiet hours, checked at SEND time, not draft time (§6.4).
  -- Start inclusive, end exclusive.
  v_hour := extract(hour from (now() at time zone 'Asia/Singapore'))::int;
  if v_hour < v_agent.quiet_hours_start or v_hour >= v_agent.quiet_hours_end then
    raise sqlstate 'PT409' using
      message = 'outside_quiet_hours',
      detail  = json_build_object(
        'quiet_hours_start', v_agent.quiet_hours_start,
        'quiet_hours_end',   v_agent.quiet_hours_end,
        'sgt_hour',          v_hour
      )::text;
  end if;

  -- §8 step 2 — MockProvider.send(), inline (amendment A1).
  v_pmid := 'mock-' || gen_random_uuid()::text;

  -- §8 step 3 — the outbound message.
  insert into messages (lead_id, agent_id, direction, body, provider, provider_msg_id)
  values (v_draft.lead_id, v_draft.agent_id, 'outbound', p_body, 'mock', v_pmid)
  returning id into v_msg_id;

  -- §8 step 4 — cadence state and draft resolution, same transaction.
  v_status := case
                when p_body is distinct from v_draft.body then 'edited'
                else 'approved'
              end;

  update leads
     set touch_count      = touch_count + 1,
         last_outbound_at = now()
   where id = v_draft.lead_id;

  -- SPEC-GAP: §8 names status and resolved_at but not drafts.body. The body is
  -- written back so the stored draft matches the message that actually went
  -- out -- otherwise an `edited` draft records text nobody ever received.
  update drafts
     set status      = v_status,
         body        = p_body,
         resolved_at = now()
   where id = p_draft_id;

  message_id := v_msg_id;
  provider_msg_id := v_pmid;
  return next;
end;
$$;

-- Same SPEC-GAP as 0002_rls.sql and 0004_supersede_fact.sql: objects created by
-- a plain migration (not supabase_admin) have no default privileges, and
-- PostgREST's RPC path checks EXECUTE before anything else.
grant execute on function approve_draft(uuid, text) to service_role;
```

Apply it:

```bash
supabase db reset          # replays 0001..0005, then re-run the seed below
pnpm seed
```

`supabase db reset` is the right move here rather than `supabase migration up`: the local database
currently holds leftovers from the last `pnpm eval` run (the eval harness truncates `agents` per
fixture — see task 12), so you want a clean schema and a fresh seed regardless.

### Verify

Confirm the function exists and all five branches behave. Grab the service-role key from
`supabase status -o json` first.

```bash
SVC=$(supabase status -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])')
DID=$(docker exec supabase_db_revive psql -U postgres -tAc \
  "select id from drafts where status='pending' limit 1;" | tr -d '\r\n ')
```

If `$DID` is empty you have no drafts yet — run a cadence tick first (Step 9 shows the UI button,
but `curl`ing `generate-drafts` works too).

| # | What to run | Expected |
|---|---|---|
| 1 | approve while SGT hour is outside `[start, end)` | `HTTP 409`, `message: "outside_quiet_hours"`, hours in `details` |
| 2 | widen to `0`/`24`, approve with a **changed** body | `HTTP 200`, `[{message_id, provider_msg_id}]`, `drafts.status = 'edited'` |
| 3 | approve a second draft with an **identical** body | `drafts.status = 'approved'` |
| 4 | approve the same draft twice | `HTTP 409`, `message: "draft_already_resolved"` |
| 5 | approve a random UUID | `HTTP 404`, `message: "draft_not_found"` |

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:54321/rest/v1/rpc/approve_draft" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
  -d "{\"p_draft_id\":\"$DID\",\"p_body\":\"hey Marcus! still looking? i can send over a few\"}"
```

Then confirm the four §8 side effects actually landed together:

```bash
docker exec supabase_db_revive psql -U postgres -tAc \
  "select d.status, d.resolved_at is not null, l.touch_count,
          (select count(*) from messages m where m.lead_id = l.id and m.direction='outbound')
     from drafts d join leads l on l.id = d.lead_id where d.id = '$DID';"
```

Observed on the verified run: `edited | t | 2 | 2` — status moved, `resolved_at` set, `touch_count`
went 1 → 2, and a second outbound message exists.

**Prove it is actually atomic** (this is the whole reason the function exists — do not skip it).
Force the *last* statement to fail and confirm the earlier ones roll back:

```bash
docker exec supabase_db_revive psql -U postgres -c \
  "alter table drafts add constraint tmp_block_approve check (status <> 'approved') not valid;"
# ... approve a pending draft with an identical body, so it would become 'approved' ...
docker exec supabase_db_revive psql -U postgres -c \
  "alter table drafts drop constraint tmp_block_approve;"
```

`not valid` matters — a plain `check` refuses to be added while an already-`approved` row exists.
Verified result: `HTTP 400` with `violates check constraint`, and `touch_count` + the outbound
message count were **unchanged** (`4|4` before and after), with the draft still `pending`. The
message insert and the `touch_count` bump both rolled back with the failing update.

---

## Step 2 — make `packages/core` erasable-syntax clean

Trap 2. In `packages/core/src/mockProvider.ts`, replace the parameter-property constructor:

```ts
  /** Injected so tests are deterministic; defaults to a real UUID. */
  constructor(private readonly newId: () => string = () => `mock-${crypto.randomUUID()}`) {}
```

with an explicit field and an assignment:

```ts
  private readonly newId: () => string

  /**
   * Injected so tests are deterministic; defaults to a real UUID.
   *
   * Written as an explicit field + assignment rather than a TypeScript
   * parameter property because `apps/web` compiles with
   * `erasableSyntaxOnly: true` (tsconfig.app.json), and a parameter property
   * is not erasable — importing @revive/core's barrel from the web app fails
   * `tsc -b` with TS1294 otherwise. packages/core is consumed as raw source by
   * both Deno and Vite, so it has to stay within the intersection of what both
   * accept.
   */
  constructor(newId: () => string = () => `mock-${crypto.randomUUID()}`) {
    this.newId = newId
  }
```

Nothing else changes. `MockProvider`'s behaviour is identical.

### Verify

```bash
pnpm test        # 202 passing, unchanged
pnpm typecheck   # clean
```

---

## Step 3 — point the browser client at the service role

Trap 1. Add to **`.env.local`** at the repo root (create it from `.env.local.example` if you have
not already):

```bash
# Local demo only. See planning-overview.md §12: the demo runs on the service
# role with a single hardcoded agent, and the README says plainly that RLS
# ships but is not exercised. Never do this against a hosted project.
VITE_SUPABASE_SERVICE_ROLE_KEY=<the SERVICE_ROLE_KEY from `supabase status -o json`>
```

Add the same line to **`.env.local.example`** (with an empty value), and amend the existing comment
there so the file does not contradict itself — it currently says *"Never prefix with `VITE_` — that
would ship the key to the browser."* That warning is still correct in general; this variable is a
deliberate, documented local-demo exception. Rewrite that block as:

```bash
# Server-side ONLY. Never prefix with VITE_ — that would ship the key to the browser.
# Used exclusively by Supabase edge functions.
ANTHROPIC_API_KEY=

# Server-side. Used by supabase/seed/seed.ts (`pnpm seed`) and packages/eval.
SUPABASE_SERVICE_ROLE_KEY=

# Local demo ONLY, and a deliberate exception to the rule above. §3 and §12 of
# planning-overview.md put the demo on the service role with one hardcoded
# agent, because the RLS policies key off an `agent_id` JWT claim the anon key
# does not carry — with the anon key every table reads back as an empty array.
# The README (task 17) states this plainly. Do not set this against a hosted
# project.
VITE_SUPABASE_SERVICE_ROLE_KEY=
```

Then replace **`apps/web/src/lib/supabase.ts`**:

```ts
import { createClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL
const serviceRoleKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.local.example to .env.local and fill in the values from `supabase status -o json`.",
  )
}

/**
 * The demo client runs on the SERVICE ROLE, deliberately (§3, §12).
 *
 * The RLS policies in 0002_rls.sql read `auth.jwt() ->> 'agent_id'`. The anon
 * key carries no such claim, so every tenant table reads back as an empty
 * array — HTTP 200, no error, nothing to debug. §12's definition of done
 * settles the trade-off: policies ship on day one, the demo runs service-role
 * with a single hardcoded agent, and the README says so plainly.
 *
 * This is safe here only because everything is local. A hosted deployment
 * would mint a real JWT carrying `agent_id` and drop back to the anon key.
 */
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
})
```

### Verify

```bash
pnpm dev
```

Open the browser console. The thrown error above should **not** appear. Leave `pnpm dev` running
for the rest of this task.

---

## Step 4 — `apps/web/src/lib/agent.ts`

§3 says the demo uses "a single hardcoded `agent_id`". A literal UUID is the wrong way to hardcode
it — `pnpm seed` deletes and reinserts agents by name, so the UUID changes on every re-seed and the
app would silently show an empty queue. Resolve the name to an id at runtime instead.

```ts
import { supabase } from "@/lib/supabase"

/**
 * SPEC-GAP: §3 says the demo uses "a single hardcoded agent_id". Hardcoding
 * the *name* rather than the UUID is the same decision with one fewer
 * footgun: `pnpm seed` deletes and reinserts agents by name (task 8), so a
 * literal UUID goes stale on every re-seed and the queue silently empties.
 *
 * Wei Ling is the seed's primary agent — six leads spanning every classify()
 * state. Terence Koh exists only as the contrasting voice for task 12's
 * two-voice eval fixture.
 */
export const DEMO_AGENT_NAME = "Wei Ling"

export async function fetchDemoAgent() {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, max_touches, quiet_hours_start, quiet_hours_end")
    .eq("name", DEMO_AGENT_NAME)
    .single()

  if (error || !data) {
    throw new Error(
      `Agent "${DEMO_AGENT_NAME}" not found. Run \`pnpm seed\`. (${error?.message ?? "no row"})`,
    )
  }
  return data
}
```

---

## Step 5 — `apps/web/src/features/queue/useDrafts.ts`

All the data access for the route, in one file. `@tanstack/react-query` is already a dependency.

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { DraftRow, LeadRow } from "@revive/core"
import { supabase } from "@/lib/supabase"
import { fetchDemoAgent } from "@/lib/agent"

/** The lead columns the queue card needs. */
export type QueueLead = Pick<
  LeadRow,
  "id" | "name" | "state" | "source" | "last_inbound_at" | "touch_count"
>

/** A draft joined to its lead via the drafts.lead_id foreign key. */
export interface QueueDraft extends DraftRow {
  lead: QueueLead
}

export function useAgent() {
  return useQuery({ queryKey: ["agent"], queryFn: fetchDemoAgent })
}

/**
 * §9: the queue holds drafts "awaiting approval" — `pending` plus
 * `needs_review`, which is a draft that needs a human decision, not one that
 * has been resolved. Anything already approved/edited/skipped has left the
 * queue.
 */
export function useQueue(agentId: string | undefined) {
  return useQuery({
    queryKey: ["queue", agentId],
    enabled: Boolean(agentId),
    queryFn: async (): Promise<QueueDraft[]> => {
      const { data, error } = await supabase
        .from("drafts")
        .select(
          "*, lead:leads(id, name, state, source, last_inbound_at, touch_count)",
        )
        .eq("agent_id", agentId!)
        .in("status", ["pending", "needs_review"])
        .order("created_at", { ascending: false })

      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as QueueDraft[]
    },
  })
}

/** §8: approve and Edit & Approve are the same call — the body may differ. */
export function useApprove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ draftId, body }: { draftId: string; body: string }) => {
      const { data, error } = await supabase.rpc("approve_draft", {
        p_draft_id: draftId,
        p_body: body,
      })
      if (error) throw error
      // Trap 4 — `returns table` means PostgREST sends a one-element array.
      const row = (data as { message_id: string; provider_msg_id: string }[] | null)?.[0]
      if (!row) throw new Error("approve_draft returned no row")
      return row
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}

/**
 * §8: "Skip stays a plain REST PATCH — it changes no cadence state, so there's
 * nothing to protect with a transaction." Note what is NOT written here:
 * leads.state (§6.1, trap 5) and touch_count (a skipped draft was never sent).
 */
export function useSkip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (draftId: string) => {
      const { error } = await supabase
        .from("drafts")
        .update({ status: "skipped", resolved_at: new Date().toISOString() })
        .eq("id", draftId)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}

/**
 * §9's "Run cadence tick" — generate-drafts for every lead of this agent.
 *
 * No `now` is sent, so §8's override guard is never engaged (that seam exists
 * for the eval harness). Clicking twice is safe: `drafts_one_pending_per_lead`
 * plus the pending-draft skip in generate-drafts make the second run a no-op.
 */
export function useCadenceTick() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await supabase.functions.invoke("generate-drafts", {
        body: { agent_id: agentId },
      })
      if (error) throw error
      return data as {
        run_id: string
        generated: number
        suppressed: number
        needs_review: number
        errors?: number
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}
```

### Verify

```bash
pnpm typecheck
```

This is the first file that imports `@revive/core` from the web app, so it is also where trap 2
would bite if Step 2 was skipped.

---

## Step 6 — `apps/web/src/features/queue/DraftCard.tsx`

§9's card spec, literally:

> - Lead name · state badge (colour per state) · `21d silent` · source badge
> - Strategy chip (`new_listing_hook`)
> - Draft body in a WhatsApp-ish bubble, **editable inline** on click
> - Buttons: **Approve** · **Edit & Approve** · **Skip** · **Why this?**
> - `needs_review` cards render with an amber left border and the failed guardrail rule stated in
>   plain language (including `tone` as a possible value — §6.4).

```tsx
import { useState } from "react"
import { diffDays } from "@revive/core"
import type { LeadState } from "@revive/core"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { QueueDraft } from "./useDrafts"

const STATE_STYLES: Record<LeadState, string> = {
  new: "bg-blue-50 text-blue-700 border-blue-200",
  warm: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cold: "bg-neutral-100 text-neutral-700 border-neutral-300",
  dormant: "bg-slate-100 text-slate-600 border-slate-300",
  handed_off: "bg-violet-50 text-violet-700 border-violet-200",
  do_not_contact: "bg-red-50 text-red-700 border-red-200",
}

/**
 * §9: "the failed guardrail rule stated in plain language (including `tone`)".
 * The rule ids come from §6.4; `tone` is set by generate-drafts when the tone
 * check fails after G1–G5 pass.
 */
const GUARDRAIL_REASONS: Record<string, string> = {
  G1: "Draft length is outside the allowed range.",
  G2: "Draft uses a banned phrase.",
  G3: "Draft mentions a number, price, district or date with no matching extracted fact.",
  G4: "Draft states eligibility or financial advice instead of asking a question.",
  G5: "Draft contains an unfilled placeholder.",
  tone: "Tone check flagged this draft as off-voice.",
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  )
}

interface Props {
  draft: QueueDraft
  now: Date
  busy: boolean
  onApprove: (body: string) => void
  onSkip: () => void
}

export function DraftCard({ draft, now, busy, onApprove, onSkip }: Props) {
  const [body, setBody] = useState(draft.body)
  const [editing, setEditing] = useState(false)

  const needsReview = draft.status === "needs_review"
  const guardrail = draft.trace?.guardrail as
    | { failed_rule?: string | null; detail?: string }
    | undefined
  const failedRule = guardrail?.failed_rule ?? null

  const daysSilent =
    draft.lead.last_inbound_at !== null ? diffDays(now, draft.lead.last_inbound_at) : null

  return (
    <article
      className={cn(
        "rounded-lg border border-neutral-200 bg-white p-4 shadow-xs",
        needsReview && "border-l-4 border-l-amber-400",
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">{draft.lead.name}</h2>
        <Chip className={STATE_STYLES[draft.lead.state]}>{draft.lead.state}</Chip>
        {daysSilent !== null && (
          <span className="text-xs text-neutral-500">{daysSilent}d silent</span>
        )}
        <Chip className="border-neutral-200 bg-neutral-50 text-neutral-600">
          {draft.lead.source}
        </Chip>
        <Chip className="ml-auto border-neutral-300 bg-neutral-100 font-mono text-neutral-700">
          {draft.strategy}
        </Chip>
      </header>

      {needsReview && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">Needs review</span> —{" "}
          {failedRule
            ? (GUARDRAIL_REASONS[failedRule] ?? `Guardrail ${failedRule} failed.`)
            : "A guardrail failed."}
          {guardrail?.detail ? ` (${guardrail.detail})` : null}
        </p>
      )}

      {/* WhatsApp-ish bubble, editable inline on click (§9). */}
      {editing ? (
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => setEditing(false)}
          rows={4}
          className="mt-3 w-full rounded-2xl rounded-tl-sm border border-emerald-300 bg-white p-3 text-sm text-neutral-900 outline-none focus:ring-2 focus:ring-emerald-200"
        />
      ) : (
        <p
          onClick={() => setEditing(true)}
          className="mt-3 cursor-text rounded-2xl rounded-tl-sm bg-emerald-50 p-3 text-sm whitespace-pre-wrap text-neutral-900"
        >
          {body}
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => onApprove(body)}>
          {body === draft.body ? "Approve" : "Edit & Approve"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
        {/* §9 lists "Why this?" on the card; TracePanel itself is task 15. */}
        <Button size="sm" variant="ghost" disabled title="Trace panel lands in task 15">
          Why this?
        </Button>
        {body !== draft.body && (
          <button
            type="button"
            onClick={() => setBody(draft.body)}
            className="text-xs text-neutral-500 underline underline-offset-2"
          >
            revert edit
          </button>
        )}
      </footer>
    </article>
  )
}
```

Two notes on the button labels. §9 lists **Approve** and **Edit & Approve** as separate buttons, but
§8 makes them the same call — `approve_draft(draft_id, body)`, with the function deciding
`approved` vs `edited` by comparing bodies. One button whose label follows the edit state is the
honest rendering of that; two buttons calling the identical RPC would be theatre. The `revert edit`
link gives you the way back.

---

## Step 7 — `apps/web/src/features/queue/QueuePage.tsx`

```tsx
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { DraftCard } from "./DraftCard"
import { useAgent, useApprove, useCadenceTick, useQueue, useSkip } from "./useDrafts"

/** PostgREST surfaces the plpgsql `raise ... using message/detail` as these. */
interface RpcError {
  code?: string
  message?: string
  details?: string
}

function quietHoursMessage(details: string | undefined): string {
  try {
    const d = JSON.parse(details ?? "{}") as {
      quiet_hours_start?: number
      quiet_hours_end?: number
      sgt_hour?: number
    }
    return `Outside quiet hours — it is ${d.sgt_hour}:00 SGT and this agent sends between ${d.quiet_hours_start}:00 and ${d.quiet_hours_end}:00.`
  } catch {
    return "Outside quiet hours."
  }
}

export function QueuePage() {
  const [banner, setBanner] = useState<string | null>(null)
  // Pinned per render pass so every card measures "days silent" against the
  // same instant (contract rule 3's habit, applied to the UI).
  const now = useMemo(() => new Date(), [])

  const agent = useAgent()
  const queue = useQueue(agent.data?.id)
  const approve = useApprove()
  const skip = useSkip()
  const tick = useCadenceTick()

  const busy = approve.isPending || skip.isPending || tick.isPending
  const drafts = queue.data ?? []

  function handleApprove(draftId: string, body: string) {
    setBanner(null)
    approve.mutate(
      { draftId, body },
      {
        onError: (err) => {
          const e = err as RpcError
          if (e.message === "outside_quiet_hours") setBanner(quietHoursMessage(e.details))
          else if (e.message === "draft_already_resolved")
            setBanner("That draft was already resolved — refreshing the queue.")
          else setBanner(e.message ?? "Approve failed.")
        },
      },
    )
  }

  function handleTick() {
    setBanner(null)
    if (!agent.data) return
    tick.mutate(agent.data.id, {
      onSuccess: (r) =>
        setBanner(
          `Cadence tick: ${r.generated} drafted · ${r.suppressed} suppressed · ${r.needs_review} need review${
            r.errors ? ` · ${r.errors} errored` : ""
          }`,
        ),
      onError: (err) => setBanner((err as RpcError).message ?? "Cadence tick failed."),
    })
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-neutral-900">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"} awaiting approval
        </h1>
        <Button className="ml-auto" disabled={busy || !agent.data} onClick={handleTick}>
          {tick.isPending ? "Running…" : "Run cadence tick"}
        </Button>
      </header>

      {banner && (
        <p className="mt-4 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
          {banner}
        </p>
      )}

      {agent.isError && (
        <p className="mt-4 text-sm text-red-700">{(agent.error as Error).message}</p>
      )}
      {queue.isError && (
        <p className="mt-4 text-sm text-red-700">{(queue.error as Error).message}</p>
      )}

      <section className="mt-4 flex flex-col gap-3">
        {queue.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}

        {!queue.isLoading && drafts.length === 0 && (
          <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            Nothing awaiting approval. Run a cadence tick to generate drafts.
          </p>
        )}

        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            now={now}
            busy={busy}
            onApprove={(body) => handleApprove(d.id, body)}
            onSkip={() => skip.mutate(d.id)}
          />
        ))}
      </section>
    </div>
  )
}
```

---

## Step 8 — routing: `App.tsx` and `main.tsx`

§9 asks for sidebar nav across two routes. `/leads/:id` is task 14, so its nav item is present and
inert for now — a nav that grows a second item next task is less churn than one invented twice.

**`apps/web/src/App.tsx`** (replaces the scaffold placeholder):

```tsx
import { NavLink, Navigate, Route, Routes } from "react-router-dom"
import { QueuePage } from "@/features/queue/QueuePage"
import { cn } from "@/lib/utils"

function Sidebar() {
  return (
    <nav className="w-44 shrink-0 border-r border-neutral-200 bg-white p-4">
      <p className="mb-4 text-sm font-semibold text-neutral-900">Revive</p>
      <NavLink
        to="/queue"
        className={({ isActive }) =>
          cn(
            "block rounded-md px-2 py-1.5 text-sm",
            isActive
              ? "bg-neutral-100 font-medium text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-50",
          )
        }
      >
        Queue
      </NavLink>
      {/* /leads/:id is task 14 — no lead is selected from here yet. */}
      <span className="mt-1 block cursor-default rounded-md px-2 py-1.5 text-sm text-neutral-400">
        Leads
      </span>
    </nav>
  )
}

export default function App() {
  return (
    <div className="flex min-h-screen bg-neutral-50">
      <Sidebar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/queue" replace />} />
          <Route path="/queue" element={<QueuePage />} />
        </Routes>
      </main>
    </div>
  )
}
```

**`apps/web/src/main.tsx`**:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
```

`retry: false` is deliberate: a failing approve should surface its 409 immediately, not after three
silent retries.

### Verify

```bash
pnpm typecheck
pnpm --filter @revive/web build
```

---

## Step 9 — run it end to end

With `pnpm dev` running and `supabase start` up, including the edge runtime:

```bash
supabase functions serve
```

Then, in the browser at `http://localhost:5173`:

| # | Do this | Expect |
|---|---|---|
| 1 | Load `/` | redirects to `/queue`, header reads `0 drafts awaiting approval` |
| 2 | Click **Run cadence tick** | banner reports drafted/suppressed/needs-review counts; cards appear |
| 3 | Click **Run cadence tick** again | **the queue does not double** — trap 6 |
| 4 | Click a draft body | it becomes a textarea; type into it; the button relabels to **Edit & Approve** |
| 5 | Click **revert edit** | body restored, button back to **Approve** |
| 6 | Click **Approve** outside 09:00–20:00 SGT | banner explains quiet hours with the real hour |
| 7 | Widen quiet hours (trap 3), click **Approve** | card leaves the queue |
| 8 | Click **Skip** on another card | card leaves the queue |

Then confirm the database agrees — the UI showing a card gone is not proof the four §8 writes
happened:

```bash
docker exec supabase_db_revive psql -U postgres -tAc \
  "select d.status, d.resolved_at is not null, l.name, l.touch_count, l.last_outbound_at is not null
     from drafts d join leads l on l.id = d.lead_id
    where d.resolved_at is not null order by d.resolved_at desc limit 5;"
```

An approved row must show `approved|t|<name>|<n>|t`; a skipped row must show `skipped|t|...` with
`touch_count` **unchanged** and no new outbound message.

At least one seeded lead should reach `needs_review` eventually — Wei Ling's six leads include
suppression cases, so a tick may produce none. To see the amber card and its plain-language reason
without waiting for a real guardrail failure, plant one:

```bash
docker exec supabase_db_revive psql -U postgres -c \
  "update drafts set status = 'needs_review',
     trace = jsonb_set(trace, '{guardrail}', '{\"failed_rule\":\"G3\"}'::jsonb)
   where status = 'pending' and id = (select id from drafts where status='pending' limit 1);"
```

The card must render with an amber left border and read *"Draft mentions a number, price, district
or date with no matching extracted fact."* Approve it afterwards to confirm `needs_review` drafts
are approvable (the function accepts both `pending` and `needs_review`).

**Reset quiet hours to 9 / 20 when you are done** (trap 3).

---

## Step 10 — keyboard shortcuts (optional)

§9: *"Keyboard: `a` approve, `s` skip, `j`/`k` move. Cheap, and it signals you've thought about the
daily-use case. **First thing to cut if hour 8 looks tight.**"*

Treat that literally — if anything above is not solid, stop here and commit. Otherwise add a
selection index to `QueuePage`:

```tsx
const [cursor, setCursor] = useState(0)

useEffect(() => {
  function onKey(e: KeyboardEvent) {
    // Never hijack keys while the operator is editing a draft.
    const el = e.target as HTMLElement
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || busy) return

    if (e.key === "j") setCursor((c) => Math.min(c + 1, drafts.length - 1))
    else if (e.key === "k") setCursor((c) => Math.max(c - 1, 0))
    else if (e.key === "a") {
      const d = drafts[cursor]
      if (d) handleApprove(d.id, d.body)
    } else if (e.key === "s") {
      const d = drafts[cursor]
      if (d) skip.mutate(d.id)
    }
  }
  window.addEventListener("keydown", onKey)
  return () => window.removeEventListener("keydown", onKey)
}, [drafts, cursor, busy])
```

Pass `selected={i === cursor}` into `DraftCard` and give the selected card a ring
(`ring-2 ring-neutral-400`). Clamp `cursor` when the list shrinks after a mutation, or approving
the last card leaves the cursor pointing past the end.

The textarea/input guard is not optional — without it, typing "as" into a draft approves and skips
it.

---

## Failure signatures

| Symptom | Cause |
|---|---|
| Queue always empty, no error, network tab green | Trap 1 — still on the anon key |
| `TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled` | Trap 2 — Step 2 skipped |
| Every approve returns 409 `outside_quiet_hours` | Trap 3 — correct behaviour, widen the window to test |
| `Cannot read properties of undefined (reading 'message_id')` | Trap 4 — read `data[0]`, not `data` |
| `TS6133: 'x' is declared but its value is never read` | Trap 7 — `noUnusedLocals` |
| `TS1484: 'DraftRow' is a type and must be imported using a type-only import` | Trap 7 — `verbatimModuleSyntax` |
| Second cadence tick doubles the queue | A draft was left `pending` after being handled — trap 6 |
| `Agent "Wei Ling" not found` | Database was reset without re-seeding — `pnpm seed` |
| `permission denied for function approve_draft` | The `grant execute` line at the end of `0005` was dropped |
| Approve works but `touch_count` never moves | You wrote a client-side PATCH instead of calling the RPC |
| Cadence tick fails with a 502 | No `ANTHROPIC_API_KEY` set — the write prompt cannot run |

---

## Acceptance and commit

### Checklist

- [ ] `supabase/migrations/0005_approve_draft.sql` exists and `supabase db reset` replays cleanly
- [ ] All five `approve_draft` branches verified: 200/edited, 200/approved, 409 quiet hours, 409 already resolved, 404 not found
- [ ] Atomicity proven by forcing the final `update drafts` to fail and confirming the message insert and `touch_count` bump both rolled back
- [ ] `packages/core/src/mockProvider.ts` no longer uses a parameter property; `pnpm test` still 202
- [ ] `/queue` lists pending + needs_review drafts with name, state badge, days-silent, source, strategy chip
- [ ] Draft body edits inline on click; the button relabels to **Edit & Approve**; `revert edit` works
- [ ] `needs_review` renders an amber left border and a plain-language rule explanation, `tone` included
- [ ] Approve calls `approve_draft`; Skip is a plain PATCH that touches only `status` and `resolved_at`
- [ ] **Run cadence tick** clicked twice does not double the queue (§12's own checkbox)
- [ ] The UI never writes `leads.state` (trap 5) — grep the diff to be sure
- [ ] Quiet hours restored to 9 / 20 before committing
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all green

### Expected tree

```
apps/web/src/
├── App.tsx                       # rewritten — router + sidebar
├── main.tsx                      # rewritten — QueryClientProvider + BrowserRouter
├── lib/
│   ├── agent.ts                  # new
│   ├── supabase.ts               # rewritten — service role
│   └── utils.ts                  # unchanged
├── components/ui/button.tsx      # unchanged
└── features/queue/
    ├── QueuePage.tsx             # new
    ├── DraftCard.tsx             # new
    └── useDrafts.ts              # new

supabase/migrations/0005_approve_draft.sql   # new
packages/core/src/mockProvider.ts            # constructor only
.env.local.example                           # + VITE_SUPABASE_SERVICE_ROLE_KEY
```

### Commit

Per contract rule 6, the task number goes in the message:

```
Task 13: /queue, DraftCard, approve/edit/skip, 0005_approve_draft.sql
```

Then update `CLAUDE.md`'s **Current state** with a Task 13 bullet — the amendment A1 debt is now
paid, so say so, and record the two build-level findings (the anon-key RLS dead end and the
`erasableSyntaxOnly` break) since both are the kind of thing the next person will otherwise
rediscover the slow way.

---

## Next

**Task 14** — `/leads/:id`: the message thread (inbound left, outbound right, timestamps) and
`FactsPanel`, one row per fact with `key`, `value`, a confidence dot, and **the evidence span quoted
with its source timestamp**, superseded facts collapsed under "history".

§9 calls that panel *"the anti-hallucination story made visible"* — it is the screen the whole
evidence rule in §5 exists to justify, so it gets the visual care. Task 13's sidebar already has its
inert nav slot waiting.
