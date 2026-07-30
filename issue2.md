# Task 2 — Schema and RLS policies

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 2:

> Write `0001_init.sql` and `0002_rls.sql` exactly as §3. Migrate. Verify RLS is on for all six tables, and that `drafts_one_pending_per_lead` exists.

**Outcome:** a local Postgres with all 7 tables, 4 enums, 5 indexes, and RLS enabled everywhere — verified by query, not by assumption. **No business logic, no TypeScript, no seed data.** Business logic starts at task 3; seeding is task 8.

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

Work top to bottom. Every step ends with a **Verify** block. If a Verify fails, fix it before moving on — later steps assume earlier ones worked.

---

## Read this before you start

### Three traps

These will produce a database that *looks* right and is wrong. Read them now, not after.

**Trap 1 — Transcribe the SQL below character for character. Do not summarize or "tidy" it.**
Two pieces get dropped most often, and both are load-bearing:
- **`drafts.run_id uuid`** — correlates a draft back to the `generate-drafts` run that produced it (§8). Absent from older drafts of the spec, so it looks optional. It isn't.
- **The partial unique index `drafts_one_pending_per_lead`** — this *is* the "clicking Run cadence tick twice does not double the queue" line in the definition of done. Without it that checkbox is unprovable.

**Trap 2 — "six tables" is a miscount. There are 7.**
The contract's §11 line says "all six tables", but §3 defines seven: `agents`, `leads`, `messages`, `lead_facts`, `drafts` (5 tenant-scoped) plus `strategy_rules`, `eval_runs` (2 global). Enable RLS on all **seven**. Do not delete a table or merge two to make the number come out to six. This is recorded as amendment **A2** in `CLAUDE.md`.

**Trap 3 — `approve_draft` is NOT part of this task.**
`planning-overview.md` §8 describes an `approve_draft` Postgres function. Do not write it here. It calls `MockProvider.send()`, which is TypeScript that does not exist until task 7, and plpgsql cannot invoke TypeScript. It ships later as `0003_approve_draft.sql`. This is amendment **A1** in `CLAUDE.md`. If you find yourself writing `create function approve_draft`, stop — you are doing task 13's work.

### Conventions

- All commands run from the repo root unless the step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- `$DB_URL` means `postgresql://postgres:postgres@127.0.0.1:54322/postgres` — the local Supabase Postgres. Set it once so the verify blocks are copy-pasteable:
  ```bash
  export DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  ```

---

## Step 0 — Docker and Supabase preflight

`supabase db reset` runs Postgres in Docker. If Docker isn't reachable from WSL, step 4 fails with an opaque error.

```bash
docker ps
```

**Expected** — a header row, with or without containers under it:

```
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
```

**Failure signatures:**

| Output | Cause | Fix |
|---|---|---|
| `The command 'docker' could not be found in this WSL 2 distro.` | WSL integration off | Docker Desktop → Settings → Resources → WSL Integration → enable for this distro → Apply & Restart → open a **new** terminal |
| `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Docker Desktop not running | Launch Docker Desktop, wait for the whale icon to stop animating |
| `permission denied while trying to connect to the Docker daemon socket` | User not in `docker` group | `sudo usermod -aG docker $USER`, then `wsl --shutdown` from Windows PowerShell |

Then make sure the Supabase stack is up:

```bash
cd $REPO && supabase status
```

If it reports the stack is not running:

```bash
cd $REPO && supabase start
```

### Verify

`supabase status` lists API URL, DB URL, Studio URL, and both keys. Do not continue until it does.

---

## Step 1 — Create the migrations directory

```bash
cd $REPO
mkdir -p supabase/migrations
```

### Verify

```bash
ls -d $REPO/supabase/migrations
```

Prints the path. (`supabase init` at task 1 created `config.toml` but not this directory.)

---

## Step 2 — Write `supabase/migrations/0001_init.sql`

Create the file with **exactly** this content. Order matters: the extension before the tables that use `gen_random_uuid()`, the enums before the tables whose columns use them, and each table before any table that references it.

```sql
-- Task 2 / planning-overview.md §3 — initial schema.
-- Transcribed literally from the contract. Do not reorder or "tidy".

create extension if not exists "pgcrypto";

create type lead_state as enum
  ('new','warm','cold','dormant','handed_off','do_not_contact');
create type qual_status as enum
  ('unqualified','partial','qualified','disqualified','handed_off');
create type msg_direction as enum ('inbound','outbound');
create type draft_status as enum
  ('pending','approved','edited','skipped','needs_review');

create table agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  voice_profile jsonb not null default '{
    "formality": 3, "warmth": 3, "brevity": 3,
    "sample_messages": [], "sign_off": "", "emoji_ok": false
  }'::jsonb,
  quiet_hours_start int not null default 9,   -- SGT hour, inclusive
  quiet_hours_end   int not null default 20,  -- SGT hour, exclusive
  max_touches int not null default 4,
  created_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  name text not null,
  phone text not null,
  source text not null default 'manual',      -- manual|meta_ad|99co|propertyguru|referral
  state lead_state not null default 'new',
  qualification_status qual_status not null default 'unqualified',
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  touch_count int not null default 0,         -- consecutive outbound with no inbound reply
  snooze_until timestamptz,
  opted_out boolean not null default false,
  created_at timestamptz not null default now()
);
create index on leads (agent_id, state);

create table messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  direction msg_direction not null,
  body text not null,
  sent_at timestamptz not null default now(),
  provider text not null default 'mock',
  provider_msg_id text
);
create index on messages (lead_id, sent_at);

create table lead_facts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  key text not null,
  value jsonb not null,
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  source_message_id uuid references messages(id) on delete set null,
  evidence text not null,                     -- verbatim span from source message
  extracted_at timestamptz not null default now(),
  superseded_at timestamptz                   -- append-only history
);
create index on lead_facts (lead_id, key, extracted_at desc);

create table strategy_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  priority int not null,                      -- higher wins
  match jsonb not null,
  strategy text not null,
  cooldown_days int not null default 5,
  enabled boolean not null default true
);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,                                -- correlates to generate-drafts response
  lead_id uuid not null references leads(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  strategy text not null,
  body text not null,
  status draft_status not null default 'pending',
  trace jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on drafts (agent_id, status, created_at desc);
-- Idempotency: a lead can have at most one pending draft at a time. Without
-- this, clicking "Run cadence tick" twice doubles the queue (review finding).
create unique index drafts_one_pending_per_lead
  on drafts (lead_id) where status = 'pending';

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  fixture_id text not null,
  passed boolean not null,
  failures jsonb not null default '[]'::jsonb,
  latency_ms int,
  cost_usd numeric(10,6),
  prompt_version text not null,
  created_at timestamptz not null default now()
);
```

**Do not add** a `strategy_rules` seed insert here. Those 10 rows belong to task 5, alongside `selectStrategy.ts`.

### Verify

```bash
grep -c "create table"        $REPO/supabase/migrations/0001_init.sql
grep -c "create type"         $REPO/supabase/migrations/0001_init.sql
grep -c "create index"        $REPO/supabase/migrations/0001_init.sql
grep -c "create unique index" $REPO/supabase/migrations/0001_init.sql
grep -c "run_id uuid,"        $REPO/supabase/migrations/0001_init.sql
```

Expected, in order: `7`, `4`, `4`, `1`, `1`.

Two of those need explaining, because both look off by one:

- **`create index` is 4, not 5.** There are five indexes, but the fifth is `create unique index` — which does not contain the substring `create index`, so the fourth command counts it separately. That fourth command returning `1` is your trap-1 check: it is the partial unique index.
- **`run_id uuid,` is 1, not 2.** Two tables have a `run_id`. The match here is `drafts.run_id`; `eval_runs.run_id` is declared `run_id uuid not null` and does not match this pattern.

---

## Step 3 — Write `supabase/migrations/0002_rls.sql`

Create the file with **exactly** this content.

Two policy shapes here. Tenant tables filter by the `agent_id` claim in the JWT. Global tables are readable by anyone and writable only by the service role — which needs no policy, because `service_role` bypasses RLS entirely.

```sql
-- Task 2 / planning-overview.md §3 — row level security.
--
-- SPEC-GAP: §11 says "all six tables"; §3 defines seven. Resolution (CLAUDE.md
-- amendment A2): RLS is enabled on all 7. The 5 tenant-scoped tables get a
-- tenant_isolation policy; the 2 global tables get a read-only select policy.
-- Writes to global tables have no policy at all — they are reachable only via
-- the service role, which bypasses RLS.
--
-- For the demo the app uses the service role from edge functions and a single
-- hardcoded agent_id. The policies still ship on day one — that's the point.

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables (5)
-- ---------------------------------------------------------------------------

alter table agents enable row level security;
create policy tenant_isolation on agents
  using (id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (id = (auth.jwt() ->> 'agent_id')::uuid);

alter table leads enable row level security;
create policy tenant_isolation on leads
  using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (agent_id = (auth.jwt() ->> 'agent_id')::uuid);

alter table messages enable row level security;
create policy tenant_isolation on messages
  using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (agent_id = (auth.jwt() ->> 'agent_id')::uuid);

alter table lead_facts enable row level security;
create policy tenant_isolation on lead_facts
  using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (agent_id = (auth.jwt() ->> 'agent_id')::uuid);

alter table drafts enable row level security;
create policy tenant_isolation on drafts
  using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (agent_id = (auth.jwt() ->> 'agent_id')::uuid);

-- ---------------------------------------------------------------------------
-- Global tables (2) — RLS enabled, read-only to anon, writes via service role
-- ---------------------------------------------------------------------------

alter table strategy_rules enable row level security;
create policy global_read on strategy_rules
  for select using (true);

alter table eval_runs enable row level security;
create policy global_read on eval_runs
  for select using (true);
```

Note `agents` uses `id = …`, not `agent_id = …` — the agent's own row *is* the tenant. Getting this wrong makes the agents table permanently invisible.

### Verify

```bash
grep -c "enable row level security" $REPO/supabase/migrations/0002_rls.sql
grep -c "create policy" $REPO/supabase/migrations/0002_rls.sql
```

Expected: `7` and `7`.

---

## Step 4 — Disable the SQL seed hook

`supabase/config.toml` ships pointing at a `seed.sql` that does not exist. Our seed is TypeScript and arrives at task 8 (`supabase/seed/seed.ts`), so turn the SQL hook off rather than leave `supabase db reset` chasing a missing file. (`CLAUDE.md` amendment A3.)

Open `$REPO/supabase/config.toml` and find the `[db.seed]` block near line 58.

**Before:**
```toml
[db.seed]
# If enabled, seeds the database after migrations during a db reset.
enabled = true
# Specifies an ordered list of seed files to load during db reset.
# Supports glob patterns relative to supabase directory: "./seeds/*.sql"
sql_paths = ["./seed.sql"]
```

**After** — change `true` to `false` on the `enabled` line. Leave `sql_paths` as it is.
```toml
[db.seed]
# If enabled, seeds the database after migrations during a db reset.
# Disabled: seeding is TypeScript (supabase/seed/seed.ts, task 8), not SQL.
enabled = false
# Specifies an ordered list of seed files to load during db reset.
# Supports glob patterns relative to supabase directory: "./seeds/*.sql"
sql_paths = ["./seed.sql"]
```

### Verify

```bash
grep -A3 "^\[db.seed\]" $REPO/supabase/config.toml | grep "enabled"
```

Prints `enabled = false`.

---

## Step 5 — A note on migration filenames

Keep the contract's literal names — `0001_init.sql` and `0002_rls.sql`. **Do not run `supabase migration new`**; it generates timestamped names like `20260730120000_init.sql`, and the contract names these files explicitly in §1.

The CLI reads a leading numeric version from the filename and applies migrations in ascending order, so `0001`/`0002` work. If `supabase migration list` in step 6 does not show them, that is the one place in this task where deviating is sanctioned: rename to the timestamp format, and add a `-- SPEC-GAP:` comment at the top of each file recording why the contract's names could not be used.

---

## Step 6 — Apply the migrations

```bash
cd $REPO
supabase db reset
```

This drops and recreates the local database, then replays every migration from scratch. It is the right command here — not `supabase migration up` — because it proves the migrations work on an empty database, which is what CI and every future teammate will do.

Expect output ending in something like `Finished supabase db reset.` with no warning about a missing seed file.

### Verify

```bash
cd $REPO && supabase migration list
```

Both `0001` and `0002` appear with a matching Local / Remote version.

---

## Step 7 — Verify the schema by query

Do not skip these. "The migration ran without error" is not the same as "the schema is right".

### 7a — All 7 tables exist with RLS on

```bash
psql "$DB_URL" -c "select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;"
```

**Expected** — exactly 7 rows, every `rowsecurity` value `t`:

```
   tablename    | rowsecurity
----------------+-------------
 agents         | t
 drafts         | t
 eval_runs      | t
 lead_facts     | t
 leads          | t
 messages       | t
 strategy_rules | t
(7 rows)
```

If any row shows `f`, the corresponding `alter table … enable row level security` is missing from `0002_rls.sql`.

### 7b — All 7 policies exist

```bash
psql "$DB_URL" -c "select tablename, policyname, cmd from pg_policies where schemaname='public' order by tablename;"
```

**Expected** — 7 rows: `tenant_isolation` / `ALL` on `agents`, `drafts`, `lead_facts`, `leads`, `messages`; `global_read` / `SELECT` on `eval_runs` and `strategy_rules`.

### 7c — The 4 enums exist with the right values

```bash
psql "$DB_URL" -c "select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as values from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname order by t.typname;"
```

**Expected:**

```
    typname    |                          values
---------------+----------------------------------------------------------
 draft_status  | pending,approved,edited,skipped,needs_review
 lead_state    | new,warm,cold,dormant,handed_off,do_not_contact
 msg_direction | inbound,outbound
 qual_status   | unqualified,partial,qualified,disqualified,handed_off
(4 rows)
```

Order within each enum matters — it is the declaration order and later code compares against these literals.

### 7d — The partial unique index exists

```bash
psql "$DB_URL" -c "select indexdef from pg_indexes where indexname='drafts_one_pending_per_lead';"
```

**Expected** — one row, and the definition must contain **both** `UNIQUE` and the `WHERE` clause:

```
CREATE UNIQUE INDEX drafts_one_pending_per_lead ON public.drafts USING btree (lead_id) WHERE (status = 'pending'::draft_status)
```

If the `WHERE` clause is missing you created a plain unique index, which would let a lead have only one draft *ever*. Fix the migration and re-run step 6.

---

## Step 8 — Verify the index actually enforces

Existence is not enforcement. This is the only real proof of the definition-of-done line *"clicking Run cadence tick twice does not double the queue"*.

```bash
psql "$DB_URL" -c "
begin;
insert into agents (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Probe Agent');
insert into leads (id, agent_id, name, phone)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'Probe Lead', '+6580000000');
insert into drafts (lead_id, agent_id, strategy, body)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'soft_check_in', 'first pending draft');
insert into drafts (lead_id, agent_id, strategy, body)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'soft_check_in', 'second pending draft');
rollback;
"
```

**Expected — an error. The error is the passing result:**

```
ERROR:  duplicate key value violates unique constraint "drafts_one_pending_per_lead"
```

If all four inserts succeed, the index is not doing its job — go back to step 7d.

Nothing is left behind either way: `psql -c` runs the whole string in one implicit transaction, so the error rolls it back.

---

## Step 9 — Verify RLS actually blocks, not just that it exists

`context.md` §8 raises this directly: shipping policies you never exercised invites *"you wrote policies you never exercised"*. One command settles it, and the recorded output is worth a line in the README.

Insert a row that persists, so there is something for the policy to hide:

```bash
psql "$DB_URL" -c "
insert into agents (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'RLS Probe Agent');
insert into leads (id, agent_id, name, phone)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'RLS Probe Lead', '+6580000000');
"
```

Load the env vars and query as **anon**:

```bash
cd $REPO
set -a; source .env.local; set +a
curl -s "$VITE_SUPABASE_URL/rest/v1/leads?select=id" -H "apikey: $VITE_SUPABASE_ANON_KEY"
```

**Expected:** `[]` — an empty array. Anon has no `agent_id` claim, so `auth.jwt() ->> 'agent_id'` is NULL, `agent_id = NULL::uuid` evaluates to NULL rather than true, and the row is filtered out. A `permission denied for table leads` error is also a pass — it means the same thing, blocked one layer earlier.

**Positive control — this matters.** An empty `[]` could equally mean you typed the URL wrong. Prove the endpoint works by asking again with the service-role key, which bypasses RLS. Get it from `supabase status`:

```bash
SERVICE_KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')
curl -s "$VITE_SUPABASE_URL/rest/v1/leads?select=id" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
```

**Expected:** one row — `[{"id":"22222222-2222-2222-2222-222222222222"}]`.

Anon `[]` **and** service-role one-row together is the proof. Either alone is not.

Clean up (cascades to `leads`):

```bash
psql "$DB_URL" -c "delete from agents where id='11111111-1111-1111-1111-111111111111';"
psql "$DB_URL" -c "select count(*) from leads;"
```

Last command prints `0`.

---

## Step 10 — Confirm nothing else regressed

```bash
cd $REPO
pnpm test
pnpm typecheck
pnpm --filter @revive/web build
```

All three exit 0. Nothing in this task touched TypeScript, so a failure here means something unrelated broke — fix it before committing.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `function gen_random_uuid() does not exist` | `create extension "pgcrypto"` missing or not the first statement | Put it at the top of `0001_init.sql`, re-run `supabase db reset` |
| `type "lead_state" does not exist` | A table was created before the enum it uses | Move all four `create type` statements above the first `create table` |
| `relation "agents" does not exist` | Tables out of FK order | Order must be `agents` → `leads` → `messages` → `lead_facts` → `strategy_rules` → `drafts` → `eval_runs` |
| `schema "auth" does not exist` | Supabase stack not running when migrations applied | `supabase start`, then `supabase db reset` |
| `policy "tenant_isolation" for table "leads" already exists` | `0002_rls.sql` applied twice | Use `supabase db reset` (full replay), not `migration up` on a dirty DB |
| Migrations don't appear in `supabase migration list` | CLI rejected the `0001_`/`0002_` filenames | See step 5 — rename to timestamp format and add the `-- SPEC-GAP:` note |
| `supabase db reset` warns about a missing seed file | Step 4 skipped | Set `enabled = false` under `[db.seed]` |
| `psql: command not found` | psql not installed in WSL | `sudo apt install postgresql-client`, or run the same SQL in Studio at http://127.0.0.1:54323 |

---

## Step 11 — Acceptance and commit

### Checklist

- [ ] `supabase db reset` completes clean, no missing-seed warning
- [ ] `supabase migration list` shows `0001` and `0002`
- [ ] `pg_tables` → 7 rows, all `rowsecurity = t`
- [ ] `pg_policies` → 7 rows (5 `tenant_isolation` + 2 `global_read`)
- [ ] 4 enums present with values in declaration order
- [ ] `drafts_one_pending_per_lead` exists **and** its `indexdef` contains the `WHERE` clause
- [ ] The double-pending-draft insert raises a unique violation
- [ ] Anon `curl` returns `[]` **and** service-role `curl` returns the row
- [ ] Probe rows deleted — `select count(*) from leads` is `0`
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm --filter @revive/web build` all pass
- [ ] No `approve_draft` function anywhere (trap 3)
- [ ] No `strategy_rules` seed rows (those are task 5)

### Expected tree

Only the paths task 2 owns.

```
$REPO/
└── supabase/
    ├── config.toml              # edited: db.seed.enabled = false
    └── migrations/
        ├── 0001_init.sql        # new
        └── 0002_rls.sql         # new
```

Nothing under `apps/`, `packages/`, or the repo root changes.

### Commit

Contract rule 6: commit after each numbered task with the task number in the message.

```bash
cd $REPO
git status
git add -A
git commit -m "Task 2: schema + RLS policies"
```

Then update the **Current state** section of `CLAUDE.md` to say task 2 complete, task 3 next.

---

## Next

Task 3 — `packages/core`: `types.ts`, `sg-rules.ts` (§4), `facts.ts` (§5). Types and constants only, no logic; `classify()` arrives at task 4.

Two things in §4 that older drafts of the spec get wrong, so read the current §4 rather than working from memory:

- **`sg-rules.ts` carries no Singapore policy numbers at all** — no ABSD rate, no LTV ratio, no MOP duration. There is no `LAST_VERIFIED` banner because there is no unverified data to flag. Just `DISTRICTS` and `AREA_ALIASES` (geography, which doesn't change), a flat `ELIGIBILITY_KEYWORDS` list, `BANNED_PHRASES`, and the three constants — `MAX_DRAFT_CHARS = 400` (not 480), `MIN_DRAFT_CHARS = 40`, `SGT_OFFSET_HOURS = 8`.
- **`ELIGIBILITY_TOPICS` has no `triggerWhen` field.** That condition-DSL was deleted on review; nothing consumes it.

`types.ts` is also where the provider seam lives — the `MessagingProvider` interface from §1, with the `// SEAM: Unipile + Meta Cloud API coexist here` comment directly above it. Do not implement `MockProvider` yet; that is task 7.
