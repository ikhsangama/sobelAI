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

-- ---------------------------------------------------------------------------
-- Table-level GRANTs
--
-- SPEC-GAP: not mentioned by §3, but required for PostgREST to reach any of
-- these tables at all, independent of RLS. Migrations run as the `postgres`
-- role; only objects created as `supabase_admin` get default privileges to
-- anon/authenticated/service_role on this Supabase Postgres image, so a
-- table created by a plain `create table` in a migration has none. Without
-- these grants, PostgREST returns "permission denied" before RLS is ever
-- evaluated — including for service_role, which has BYPASSRLS but still
-- needs a baseline grant. Simplest option per contract rule 1: grant the
-- same privilege shape to anon/authenticated/service_role on every table,
-- and let RLS (tenant_isolation / global_read, above) do the real narrowing.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on agents, leads, messages, lead_facts, drafts
  to anon, authenticated, service_role;

grant select on strategy_rules, eval_runs to anon, authenticated, service_role;
grant insert, update, delete on strategy_rules, eval_runs to service_role;
