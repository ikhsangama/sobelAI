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
