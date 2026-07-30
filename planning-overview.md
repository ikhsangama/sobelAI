# CLAUDE.md — Revive: Cold-Lead Follow-Up Engine

This file is the implementation contract. Everything here is a **decision already made**.

## Rules for you (Claude Code)

1. **Do not invent business logic.** Strategy rules, state thresholds, banned phrases, and required-fact sets are specified literally below. If something is genuinely unspecified, add a `// SPEC-GAP:` comment and pick the simplest option — do not silently design.
2. **Do not add features.** No auth UI, no billing, no real WhatsApp send, no broadcasts, no dark mode toggle, no landing page. Scope creep is the main failure mode here.
3. **Deterministic stages must be pure functions with unit tests.** `classify()` and `selectStrategy()` take plain objects and return plain values. No DB calls, no LLM calls, no `Date.now()` inside them — pass `now` in.
4. **Every LLM call goes through `packages/llm/src/call.ts`** which logs `{stage, model, prompt_version, input_tokens, output_tokens, latency_ms, cost_usd}`. No direct SDK calls anywhere else.
5. **Never fabricate facts.** See the evidence rule in §5. This is the single most important correctness property in the repo.
6. Work through §11 in order. Commit after each numbered task with the task number in the message.

---

## 1. Repo structure

```
revive/
├── CLAUDE.md
├── README.md
├── package.json                 # pnpm workspaces
├── pnpm-workspace.yaml
├── apps/
│   └── web/                     # Vite + React 19 + TS
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── lib/supabase.ts
│       │   ├── components/ui/           # shadcn
│       │   ├── features/queue/
│       │   │   ├── QueuePage.tsx
│       │   │   ├── DraftCard.tsx
│       │   │   └── useDrafts.ts
│       │   ├── features/thread/
│       │   │   ├── ThreadView.tsx
│       │   │   └── FactsPanel.tsx
│       │   └── features/trace/
│       │       └── TracePanel.tsx
│       │       # features/settings/VoiceProfileForm.tsx — CUT, see §9
├── packages/
│   ├── core/                    # pure, no I/O — the brain
│   │   ├── src/
│   │   │   ├── classify.ts
│   │   │   ├── selectStrategy.ts
│   │   │   ├── guardrail.ts     # deterministic half only
│   │   │   ├── facts.ts         # fact keys, required sets, gap detection
│   │   │   ├── sg-rules.ts
│   │   │   ├── types.ts
│   │   │   └── *.test.ts
│   ├── llm/
│   │   ├── src/call.ts
│   │   ├── src/prompts/extract.ts
│   │   ├── src/prompts/write.ts
│   │   └── src/prompts/toneCheck.ts
│   └── eval/
│       ├── src/run.ts           # `pnpm eval`
│       ├── src/assertions.ts
│       └── fixtures/*.json
└── supabase/
    ├── migrations/0001_init.sql
    ├── migrations/0002_rls.sql
    ├── seed/seed.ts
    └── functions/
        ├── extract-facts/index.ts
        ├── generate-drafts/index.ts
        └── ingest-inbound/index.ts
```

**Provider seam (important, do not skip):** `packages/core/src/types.ts` exports

```ts
export interface MessagingProvider {
  name: 'mock' | 'unipile' | 'meta_cloud';
  send(to: string, body: string): Promise<{ providerMsgId: string }>;
  parseWebhook(payload: unknown): InboundMessage[];
}
```

Implement `MockProvider` only (writes to `messages` with `direction='outbound'`). Add `// SEAM: Unipile + Meta Cloud API coexist here` above the interface.

---

## 2. Stack / setup

React 19 + TypeScript + Vite · Tailwind v4 + shadcn (Radix) · TanStack React Query · Supabase local (Postgres + RLS + Edge Functions, Deno) · pnpm workspaces · Vitest.

**On React 19 vs the JD's "React 18":** the job description names React 18, and this is a deliberate, disclosable departure — not drift. `npm create vite@latest` ships React 19 today, and shadcn's current install path assumes Tailwind v4 (the `@tailwindcss/vite` plugin and CSS-first config, no `tailwind.config.js`). Pinning back to 18 + Tailwind v3 means fighting both CLIs off their happy path for a one-day build, and nothing in this contract's business logic — the pipeline, the guardrails, the eval harness — touches a React version-specific API. Worth one line in the README's "what I cut and why" so it reads as a decision rather than an accident. If the founder's existing codebase is on 18, this is a `pnpm add react@18 react-dom@18` away and the Tailwind config is the only real work.

Env: `.env.local` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and server-side `ANTHROPIC_API_KEY`. Never expose the LLM key to the client — all LLM calls happen in edge functions.

Model: `claude-sonnet-4-6` for write + extract, same for tone check. Temperature 0.3 for extract, 0.7 for write, 0 for tone check.

---

## 3. Schema — `supabase/migrations/0001_init.sql`

```sql
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

**`0002_rls.sql`** — enable RLS on all six tenant tables. Policy pattern for each:

```sql
alter table leads enable row level security;
create policy tenant_isolation on leads
  using (agent_id = (auth.jwt() ->> 'agent_id')::uuid)
  with check (agent_id = (auth.jwt() ->> 'agent_id')::uuid);
```

Repeat for `messages`, `lead_facts`, `drafts`. `agents`: `using (id = (auth.jwt() ->> 'agent_id')::uuid)`. `strategy_rules` and `eval_runs` are global — RLS enabled, read-only to anon, writes via service role only.

For the demo the app uses the service role from edge functions and a single hardcoded `agent_id`. **Policies still ship on day one** — that's the point.

---

## 4. `packages/core/src/sg-rules.ts` — literal content

```ts
/**
 * DISTRICTS and AREA_ALIASES are geography — they don't change.
 *
 * No Singapore property POLICY threshold (ABSD rate, LTV ratio, MOP duration,
 * EIP quota) is encoded anywhere in this file, or anywhere in this repo, by
 * design. ELIGIBILITY_TOPICS below only decides which clarifying QUESTION the
 * assistant asks (see guardrail G4 — "no advice"); the system never asserts
 * an eligibility fact or a number tied to one.
 */

export const DISTRICTS = {
  D01: { region: 'CCR', areas: ['Raffles Place', 'Marina', 'Cecil'] },
  D02: { region: 'CCR', areas: ['Tanjong Pagar', 'Anson'] },
  D03: { region: 'RCR', areas: ['Queenstown', 'Tiong Bahru', 'Alexandra'] },
  D04: { region: 'RCR', areas: ['Sentosa', 'Harbourfront', 'Telok Blangah'] },
  D05: { region: 'RCR', areas: ['Clementi', 'Pasir Panjang', 'West Coast'] },
  D06: { region: 'CCR', areas: ['High Street', 'Beach Road', 'City Hall'] },
  D07: { region: 'CCR', areas: ['Bugis', 'Rochor', 'Golden Mile'] },
  D08: { region: 'RCR', areas: ['Little India', 'Farrer Park'] },
  D09: { region: 'CCR', areas: ['Orchard', 'River Valley', 'Somerset'] },
  D10: { region: 'CCR', areas: ['Tanglin', 'Holland', 'Bukit Timah'] },
  D11: { region: 'CCR', areas: ['Newton', 'Novena', 'Watten', 'Thomson'] },
  D12: { region: 'RCR', areas: ['Balestier', 'Toa Payoh', 'Serangoon'] },
  D13: { region: 'RCR', areas: ['Macpherson', 'Braddell', 'Potong Pasir'] },
  D14: { region: 'RCR', areas: ['Geylang', 'Eunos', 'Paya Lebar'] },
  D15: { region: 'RCR', areas: ['East Coast', 'Marine Parade', 'Katong', 'Joo Chiat'] },
  D16: { region: 'OCR', areas: ['Bedok', 'Upper East Coast', 'Siglap'] },
  D17: { region: 'OCR', areas: ['Changi', 'Loyang', 'Flora'] },
  D18: { region: 'OCR', areas: ['Tampines', 'Pasir Ris'] },
  D19: { region: 'OCR', areas: ['Hougang', 'Punggol', 'Sengkang', 'Serangoon Gardens'] },
  D20: { region: 'OCR', areas: ['Ang Mo Kio', 'Bishan', 'Thomson'] },
  D21: { region: 'OCR', areas: ['Upper Bukit Timah', 'Clementi Park', 'Ulu Pandan'] },
  D22: { region: 'OCR', areas: ['Jurong', 'Boon Lay', 'Tuas'] },
  D23: { region: 'OCR', areas: ['Bukit Batok', 'Bukit Panjang', 'Choa Chu Kang', 'Dairy Farm'] },
  D24: { region: 'OCR', areas: ['Lim Chu Kang', 'Tengah'] },
  D25: { region: 'OCR', areas: ['Admiralty', 'Woodlands'] },
  D26: { region: 'OCR', areas: ['Mandai', 'Upper Thomson'] },
  D27: { region: 'OCR', areas: ['Sembawang', 'Yishun'] },
  D28: { region: 'OCR', areas: ['Seletar', 'Yio Chu Kang'] },
} as const;

/** Colloquial → district. Lowercased substring match, longest match wins. */
export const AREA_ALIASES: Record<string, keyof typeof DISTRICTS> = {
  'east coast': 'D15', 'katong': 'D15', 'joo chiat': 'D15', 'marine parade': 'D15',
  'bishan': 'D20', 'amk': 'D20', 'ang mo kio': 'D20',
  'cck': 'D23', 'choa chu kang': 'D23', 'bukit batok': 'D23',
  'tpy': 'D12', 'toa payoh': 'D12',
  'orchard': 'D09', 'river valley': 'D09',
  'holland v': 'D10', 'holland village': 'D10', 'bukit timah': 'D10',
  'tampines': 'D18', 'pasir ris': 'D18',
  'punggol': 'D19', 'sengkang': 'D19', 'hougang': 'D19',
  'yishun': 'D27', 'sembawang': 'D27',
  'woodlands': 'D25', 'admiralty': 'D25',
  'jurong': 'D22', 'boon lay': 'D22',
  'clementi': 'D05', 'west coast': 'D05',
  'tiong bahru': 'D03', 'queenstown': 'D03',
  'bedok': 'D16', 'siglap': 'D16',
  'novena': 'D11', 'newton': 'D11', 'thomson': 'D11',
  'tanjong pagar': 'D02',
  'geylang': 'D14', 'paya lebar': 'D14',
};

export type BuyerProfile = 'citizen' | 'pr' | 'foreigner' | 'unknown';

/**
 * The keywords G4 ("no advice") checks for — if a draft mentions any of
 * these, it must phrase the sentence as a question (see G4).
 *
 * `ask` is documentation of *why* each topic exists, not executable logic.
 * // SPEC-GAP: an earlier draft had a `triggerWhen` field meant to gate which
 * question fill_missing_fact should ask. Nothing in §6.3 or §7.2 consumes a
 * condition language, and building a parser for one is scope this repo
 * doesn't need — fill_missing_fact fills gaps from REQUIRED_FOR_QUALIFIED
 * only (§5). Deleted rather than left unevaluated.
 */
export const ELIGIBILITY_TOPICS = [
  { id: 'mop',       ask: 'whether their HDB has met its Minimum Occupation Period' },
  { id: 'absd',      ask: 'whether they have factored in Additional Buyer\'s Stamp Duty' },
  { id: 'eip',       ask: 'whether the block still has quota under the Ethnic Integration Policy' },
  { id: 'ltv',       ask: 'whether their loan-to-value limit is affected by an existing mortgage' },
  { id: 'lease_min', ask: 'their intended lease term (HDB has a minimum tenancy period)' },
] as const;

/** Flat keyword list G4 scans for — the only part of ELIGIBILITY_TOPICS that's executable. */
export const ELIGIBILITY_KEYWORDS = ['MOP', 'ABSD', 'EIP', 'LTV', 'stamp duty'] as const;

/** Deterministic guardrail: reject the draft outright. Case-insensitive. */
export const BANNED_PHRASES = [
  'guaranteed', 'guarantee', 'sure profit', 'no risk', 'risk-free',
  'will definitely appreciate', 'confirm will appreciate', 'confirm can',
  'you qualify', 'you are eligible', 'you will be eligible',
  'best price in the market', 'last unit', 'only one left',
  'must buy now', 'price will go up next week',
  'i can get you approved', 'financing is not a problem',
];

/**
 * The ONE length limit in the repo. §7.2 and §7.3 both reference this
 * constant by name instead of restating a number — three different numbers
 * (480/400/~400) used to appear across sg-rules.ts and the two prompts,
 * which meant a 430-char draft could pass G1 and still fail tone check for
 * a reason the agent couldn't act on. Fixed by having one source of truth.
 */
export const MAX_DRAFT_CHARS = 400;
export const MIN_DRAFT_CHARS = 40;
export const SGT_OFFSET_HOURS = 8;
```

---

## 5. Facts — `packages/core/src/facts.ts`

```ts
export const FACT_KEYS = [
  'transaction_type',   // 'buy' | 'rent' | 'sell'
  'property_type',      // 'hdb' | 'hdb_resale' | 'condo' | 'ec' | 'landed'
  'budget_min',         // number, SGD
  'budget_max',         // number, SGD
  'districts',          // string[] e.g. ['D15','D16']
  'bedrooms',           // number
  'timeline',           // 'immediate' | '1_3_months' | '3_6_months' | '6_12_months' | 'exploring'
  'buyer_profile',      // 'citizen' | 'pr' | 'foreigner'
  'current_housing',    // 'hdb' | 'condo' | 'renting' | 'with_family'
  'purpose',            // 'own_stay' | 'investment'
  'lease_term',         // string, rentals only
  'move_in_date',       // ISO date, rentals only
  'owns_property',      // boolean
  'has_existing_loan',  // boolean
] as const;

/** A lead is `qualified` only when all four are present. */
export const REQUIRED_FOR_QUALIFIED = [
  'transaction_type', 'budget_max', 'districts', 'timeline',
] as const;

export function factGaps(facts: Fact[]): string[] {
  const present = new Set(facts.filter(f => !f.superseded_at).map(f => f.key));
  return REQUIRED_FOR_QUALIFIED.filter(k => !present.has(k));
}
```

### The evidence rule (non-negotiable)

Every `lead_facts` row **must** have a non-empty `evidence` string that appears **verbatim as a substring** of the body of `source_message_id`. Enforce it in three places:

1. **Prompt** (§7.1) instructs the model to emit `evidence` and to omit the field entirely if it can't.
2. **Server validation** in `extract-facts`: for each returned fact, assert `message.body.toLowerCase().includes(evidence.toLowerCase())`. If false → **discard the fact**, log `evidence_mismatch`, do not insert.
3. **Numeric cross-check** (closes a real gap: verbatim-but-wrong-value facts pass 1–2 and then pass G3, because G3 checks the draft against this same corrupted fact set). For `budget_min`, `budget_max`, and `bedrooms`: run the G3 number normalizer (§6.4) over the `evidence` span and require the parsed number to be within ±2% of the emitted `value`. Mismatch → **discard the fact**, log `value_evidence_mismatch`, do not insert.
4. **Test**: `facts.test.ts` includes a case where the model output is stubbed with a fabricated evidence span and asserts zero rows inserted, plus a case where evidence is verbatim but the emitted value doesn't match it (e.g. evidence `"around 1.5m"`, value `3000000`) and asserts that fact is also rejected.

This changes what the evidence rule actually proves: it makes the model unable to invent an entity with no textual source, but a model can still *misread* a value inside a real span — that residual gap is what the human approval gate exists to catch, not a fourth automated layer.

Superseding: when a new extraction produces a different value for an existing key, set `superseded_at = now()` on the old row and insert a new one. Never UPDATE a fact value.

---

## 6. Deterministic stages

### 6.1 `classify.ts`

```ts
export function classify(lead: LeadRow, now: Date): LeadState {
  if (lead.opted_out) return 'do_not_contact';
  if (lead.qualification_status === 'handed_off') return 'handed_off';
  if (lead.qualification_status === 'disqualified') return 'do_not_contact';

  const daysSinceInbound = lead.last_inbound_at
    ? diffDays(now, lead.last_inbound_at) : null;
  const daysSinceCreated = diffDays(now, lead.created_at);

  if (lead.touch_count === 0 && daysSinceInbound === null && daysSinceCreated <= 2)
    return 'new';
  if (daysSinceInbound !== null && daysSinceInbound <= 7)  return 'warm';
  if (daysSinceInbound !== null && daysSinceInbound <= 45)  return 'cold';
  if (daysSinceInbound !== null)                            return 'dormant';
  return daysSinceCreated <= 45 ? 'cold' : 'dormant';
}
```

Unit tests: exact boundaries at 2/7/45 days, null-inbound branches, all three short-circuits.

**`leads.state` is a denormalized cache, not a second source of truth.** `classify()` is the only thing that ever decides state; the column exists purely so the UI can badge/filter without recomputing on every read. `generate-drafts` writes `leads.state = classify(lead, now)` at the top of every run, before evaluating any rule, and that write is the only writer of the column anywhere in the system — `ingest-inbound` never touches it, even though it does touch `opted_out`. Any fixture assertion on `state` (e.g. F05) reads the **stored column after a `generate-drafts` run**, not `trace.state` in isolation, since those two are guaranteed identical only after that write happens.

**One accepted, documented fallthrough:** a `new` lead from a source other than `meta_ad` matches no `strategy_rules` row for its first two days (rule 75 requires `meta_ad`; rules 40/50/60 require `cold`) — it suppresses with `no_rule_matched`, then silently becomes `cold` via the `classify()` fall-through on day 3 and starts receiving `gentle_check_in`. This is accepted behavior, not a bug: a non-ad lead genuinely has no qualification step to trigger, and two days of silence before the cadence engine picks it up is an acceptable cold-start. Called out here so it's a choice, not a surprise.

### 6.2 Opt-out detection (`ingest-inbound`, deterministic, no LLM)

On every inbound, lowercase and check for: `stop`, `unsubscribe`, `remove me`, `don't message`, `dont message`, `stop messaging`, `not interested anymore`, `already bought`, `already rented`, `found already`, `got already`, `dont contact`. Match → `opted_out = true`. Also detect snooze intent: `call me next month`, `next month`, `after cny`, `after chinese new year`, `q1`, `next year`, `busy now` → set `snooze_until` (+30 days default; +60 for "next year"). Log which keyword fired into the trace.

### 6.3 `selectStrategy.ts` + `strategy_rules` seed rows

Evaluate all enabled rules, keep those whose `match` is satisfied, return the highest `priority`. Ties are impossible — priorities are unique.

| priority | name | strategy | match | cooldown |
|---|---|---|---|---|
| 100 | `hard_suppress` | `suppress` | `state in ['do_not_contact','handed_off']` | 0 |
| 95 | `snoozed` | `suppress` | `snooze_until > now` | 0 |
| 90 | `touch_cap` | `suppress` | `touch_count >= agent.max_touches` | 0 |
| 80 | `warm_human_handles` | `suppress` | `state == 'warm' && touch_count > 0` | 0 |
| 75 | `new_ad_lead` | `instant_qualify` | `state == 'new' && source == 'meta_ad'` | 0 |
| 70 | `last_chance` | `final_nudge` | `state in ['cold','dormant'] && touch_count == agent.max_touches - 1` | 7 |
| 60 | `gap_fill` | `fill_missing_fact` | `state in ['cold','dormant'] && fact_gaps.length > 0` | 5 |
| 50 | `listing_hook` | `new_listing_hook` | `state == 'cold' && days_silent >= 14 && fact_gaps.length == 0` | 5 |
| 40 | `gentle_check_in` | `soft_check_in` | `state == 'cold' && touch_count <= 2` | 5 |
| 30 | `long_dormant` | `market_update` | `state == 'dormant'` | 14 |

**`warm_human_handles`'s match gained `&& touch_count > 0`.** As originally written (`state == 'warm'` alone), a fresh Meta ad lead's very first inbound message sets `daysSinceInbound = 0`, which makes `classify()` return `warm` immediately — so `warm_human_handles` (priority 80) suppressed the lead before `new_ad_lead` (priority 75) ever got evaluated, and `instant_qualify` could only fire for a lead with zero inbound messages ever, which is a lead with no ad-form content to qualify. The added clause means "the AI stays out of a *conversation it's already part of*" — a lead the agent hasn't touched yet isn't a conversation being handled, it's an unqualified lead waiting on the ad-qualification step. Note at 80: **if a lead the AI has messaged before replies within 7 days, the AI stays out of it.** That's the product's core promise ("the agent stays in control of every real conversation") expressed as a rule.

**Cooldown is a post-selection check, not a table row.** An earlier draft had a row `cooldown_active` at priority 85 matching `days_since_outbound < rule_cooldown` against its own `cooldown_days: 0` — which is `days_since_outbound < 0`, always false, and circular besides: you can't know which rule's cooldown applies until after a rule has already won. `selectStrategy()` instead does this as a second step, after the highest-priority matching rule is chosen: if `days_since_outbound < winner.cooldown_days`, return `suppress` with `trace.rule_fired = 'cooldown_active'` and `trace.suppressed_by_cooldown = winner.name` — naming which rule's cooldown is blocking it, same as any other suppression reason. This also makes guardrail **G5 (§6.4, old numbering) dead code and it's removed** — the two were the same policy enforced twice at different layers against different data.

If no rule matches → `suppress` with reason `no_rule_matched`.

### 6.4 `guardrail.ts` — deterministic half

Run in order; first failure wins. Return `{ pass: boolean, failedRule?: string, detail?: string }`.

Two checks from an earlier draft are **not** here, moved/removed on review:

- **Quiet hours** is a send-time policy, not a draft-time one — a draft generated at 21:00 SGT and approved at 10:00 SGT the next day was never actually sent outside quiet hours, so checking it at generation time produced clock-dependent `needs_review` cards for no real reason. It now runs inside `approve_draft` (§8), where "current SGT hour" is actually the hour the message would send.
- **No-double-send** duplicated the `cooldown_active` post-selection check now in `selectStrategy()` (§6.3) — same policy, two layers, two data sources, and unreachable besides (the strategy layer suppresses first). Deleted.

- **G1 length** — `MIN_DRAFT_CHARS <= len <= MAX_DRAFT_CHARS`
- **G2 banned phrase** — no `BANNED_PHRASES` substring
- **G3 no invented numbers** — the check everything else in the repo's anti-hallucination story rests on, so the normalizer is specified literally rather than left for an implementer to improvise:
  1. Match `/(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?/gi` across the draft. Multiply the number by `1e3` for a `k` suffix, `1e6` for `m`/`mil`/`million`. This step must run **before** filtering — "1.5m" and "900k" are the canonical way prices appear in this domain, and unnormalized they read as `1.5` and `900`, both under the ≥1000 threshold, which would let a fabricated price pass silently.
  2. Also apply a small word-number map (`one`…`ten`, `hundred`, `thousand`, `million`) over the same pipeline, so "one point two million" gets caught too.
  3. Whitelist bare 4-digit integers in the range 2020–2035 as years, not price/amount tokens — otherwise every `market_update` draft that mentions the current year fails on a false positive.
  4. Extract every remaining number ≥ 1000, every `$`-amount, every `DXX`, and every date-like token. Each must appear in the fact set (numbers within ±2% of a fact value, to allow "1.2m" ↔ `1200000`). Otherwise fail with the offending token.
  5. State the residual limitation in the README (task 17): this is a token-level check — a sufficiently novel obfuscation could still slip through, which is exactly why the message still needs human approval before it sends.

  Write these five as the **first tests** in this task — §11 already flags G3 as the check that matters most; this is what "most tests" means concretely.
- **G4 no advice** (renumbered — was G6) — draft must not contain a declarative eligibility/financial claim. Heuristic: if it mentions any `ELIGIBILITY_KEYWORDS` term (§4: `MOP`, `ABSD`, `EIP`, `LTV`, `stamp duty`) it must be phrased as a question — require a `?` in the same sentence. Fail otherwise.
- **G5 placeholder leak** (renumbered — was G7) — no `[`, `{{`, `XXX`, `<name>`, `TODO`

Failure → draft saved with `status='needs_review'` and the failed rule in the trace. **Never drop silently.**

**Tone check is not part of this file** (it's an LLM call, run by `generate-drafts` in task 11 after G1–G5 pass), but its failure mode needs to be as explicit as the deterministic ones or it's an unspecified branch: **tone-check fail → `needs_review`, `trace.guardrail.failed_rule = 'tone'`, the model's `reasons` array copied into the trace verbatim. Never auto-retry** — a silent retry would make the cost/latency numbers in the trace panel (§9 `TracePanel`) understate what the draft actually cost.

---

## 7. Prompts — literal text

All prompts live in `packages/llm/src/prompts/` and export `{ version, system, buildUser }`. Bump `version` on every edit — it's written to `eval_runs.prompt_version`.

### 7.1 `extract.ts` — `version = 'extract-v1'`

```
SYSTEM:
You extract structured facts from WhatsApp conversations between a Singapore
property agent and a lead. You are a transcriber, not an analyst.

Rules:
- Output ONLY a JSON object. No prose, no markdown fences.
- Shape: {"facts":[{"key":..,"value":..,"confidence":0-1,
           "source_message_index":<int>,"evidence":"<verbatim substring>"}]}
- `evidence` MUST be an exact substring copied character-for-character from the
  message at `source_message_index`. Never paraphrase it. Never reconstruct it.
- If you cannot point to a verbatim span, OMIT the fact entirely. An omitted
  fact is always better than an inferred one.
- Do not infer. "I stay in Tampines" describes where the lead currently
  lives, not a district they want to buy in — do not emit a `districts` fact
  from it. "Maybe around 1m" is budget_max=1000000 with confidence 0.6, not
  1.0.
- Only these keys: <FACT_KEYS>
- Budgets: convert to plain SGD integers. "1.2m"=1200000, "800k"=800000.
  "under 1m" => budget_max only. "1 to 1.2m" => budget_min and budget_max.
- Districts: return the DXX code. Map colloquial names using: <AREA_ALIASES>
  If a location is ambiguous, omit it.
- The conversation may be in Singlish or mixed English/Chinese. Handle both.
- If the lead contradicts an earlier statement, extract only the MOST RECENT value.

USER:
Messages (index: direction: body):
<numbered message list, last 20>
```

### 7.2 `write.ts` — `version = 'write-v1'`

```
SYSTEM:
You draft a single WhatsApp follow-up message that a Singapore property agent
will read and approve before it is sent. You are ghostwriting as the agent.

Hard constraints:
- Output ONLY a JSON object: {"message":..,"facts_referenced":[..],"confidence":0-1}
- ONE message. Under MAX_DRAFT_CHARS characters (400 — see sg-rules.ts, the
  same number G1 and the tone check enforce). WhatsApp register: short lines,
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
  following up, and leave the door open. No guilt, no urgency.

`strategy` here is never `suppress` — `generate-drafts` (§8) checks for that
strategy immediately after `selectStrategy()` and returns before this prompt
is ever built, so there's no LLM call to pay for and no `usage.write` entry
to fabricate a value for. An earlier draft had the model return an empty
message for this case instead; removing the branch here means it's
structurally unreachable rather than a path an implementer has to trust the
model not to take.

USER:
AGENT NAME: <name>
VOICE: formality <1-5>/5, warmth <1-5>/5, brevity <1-5>/5, emoji <ok|no>,
       sign-off: "<sign_off>"
SAMPLE MESSAGES BY THIS AGENT (match the rhythm, not the content):
<up to 3 samples>
STRATEGY: <strategy>
GAP TO FILL (if any): <gap>
FACTS (the ONLY facts you may reference):
<key: value lines>
LAST 6 MESSAGES:
<numbered list>
DAYS SINCE LEAD LAST REPLIED: <n>
```

### 7.3 `toneCheck.ts` — `version = 'tone-v1'`, temperature 0

```
SYSTEM:
You are a strict reviewer. Judge one drafted WhatsApp message from a Singapore
property agent to a lead.

Output ONLY: {"verdict":"pass"|"fail","reasons":[".."]}

Fail if ANY of:
- Pushy, guilt-inducing, or manufacturing urgency
- Claims or implies eligibility, approval, returns, or appreciation
- References a specific price, district, project, date, or unit type NOT in FACTS
- Reads as a mass template rather than a message to this person
- Longer than MAX_DRAFT_CHARS characters (400), or formatted like an email
- Apologetic or servile in tone

Be strict. A false fail costs one draft. A false pass costs the agent's
reputation and possibly their WhatsApp number.

USER:
FACTS: <key: value lines>
DRAFT: <message>
```

---

## 8. API contracts (edge functions)

### `POST /functions/v1/ingest-inbound`
```jsonc
// req
{ "agent_id": "uuid", "lead_id": "uuid", "body": "string", "sent_at": "ISO?" }
// res 200
{ "message_id": "uuid", "opt_out_detected": false, "snooze_until": null,
  "keyword_hit": null, "facts_refreshed": 3 }
```
Inserts message, runs opt-out/snooze detection, sets `last_inbound_at = sent_at`, resets `touch_count = 0`, then calls `extract-facts`.

### `POST /functions/v1/extract-facts`
```jsonc
// req
{ "lead_id": "uuid", "force": false }
// res 200
{ "lead_id": "uuid", "inserted": 3, "superseded": 1, "rejected": 1,
  "rejections": [{ "key": "budget_max", "reason": "evidence_mismatch",
                   "evidence": "around 1.5m" }],
  "facts": [{ "key": "districts", "value": ["D15"], "confidence": 0.9,
              "evidence": "looking at katong area", "source_message_id": "uuid" }],
  "usage": { "latency_ms": 1180, "cost_usd": 0.0021, "prompt_version": "extract-v1" } }
```

### `POST /functions/v1/generate-drafts`

Orchestrates classify → selectStrategy → write → guardrail → toneCheck for each targeted lead. Before evaluating rules, writes `leads.state = classify(lead, now)` — this is the only writer of that column (§6.1).

**Idempotency:** for each lead, skip and record `outcome: "skipped"`, `trace.skipped_reason: "existing_pending_draft"` if a `pending` draft already exists for it (enforced by `drafts_one_pending_per_lead`, §3). Without this, clicking "Run cadence tick" a second time before the queue is cleared doubles every draft.

**`now` override guard:** `now` exists so the eval harness can test time-dependent behavior without mocking the clock (§10) — it is not a general-purpose feature. Reject the request with 400 unless `dry_run: true` **or** the caller presents the service-role key. A client-supplied arbitrary clock is a testing seam, not something the public API should honor.

**`suppress` never reaches the LLM.** If `selectStrategy()` returns `strategy: 'suppress'`, `generate-drafts` returns immediately with `outcome: 'suppressed'` and no `drafts` row — the write prompt (§7.2) is never called, so there's no `usage.write` entry to report for that lead.

```jsonc
// req
{ "agent_id": "uuid", "lead_ids": ["uuid"] | null, "now": "ISO?", "dry_run": false }
// res 200
{ "run_id": "uuid", "generated": 4, "suppressed": 2, "needs_review": 1,
  "results": [{
    "lead_id": "uuid", "draft_id": "uuid|null", "outcome": "drafted|suppressed|needs_review",
    "trace": {
      "state": "cold",
      "state_inputs": { "days_since_inbound": 21, "touch_count": 1, "opted_out": false },
      "rule_fired": "listing_hook", "rule_priority": 50,
      "rules_evaluated": [{ "name": "warm_human_handles", "matched": false }],
      "strategy": "new_listing_hook",
      "fact_gaps": [],
      "facts_used": ["districts", "budget_max", "transaction_type"],
      "facts_referenced_by_model": ["districts", "budget_max"],
      "guardrail": { "deterministic": "pass", "tone": "pass", "failed_rule": null },
      "usage": { "write": { "latency_ms": 1620, "cost_usd": 0.0043 },
                 "tone":  { "latency_ms": 640,  "cost_usd": 0.0009 } },
      "prompt_versions": { "write": "write-v1", "tone": "tone-v1" }
    }
  }] }
```
`facts_used` is what `selectStrategy`/`fill_missing_fact` determined were relevant; `facts_referenced_by_model` is the `facts_referenced` array the write prompt (§7.2) actually returned. `generate-drafts` logs both rather than discarding the model's own list — a model that references a fact outside `facts_used` is a signal worth seeing in the trace panel even though it isn't (yet) a hard failure.

### `POST /rest/v1/rpc/approve_draft`
```jsonc
// req
{ "draft_id": "uuid", "body": "string" }   // body may differ from drafts.body if the agent edited it
// res 200
{ "message_id": "uuid", "provider_msg_id": "string" }
// res 409 (quiet hours)
{ "error": "outside_quiet_hours", "quiet_hours_start": 9, "quiet_hours_end": 20 }
```

Replaces an earlier plain `PATCH /rest/v1/drafts` design. A client-side PATCH can't do the following four things atomically, and a partial failure desyncs `touch_count` — which directly feeds `touch_cap` and `last_chance` (§6.3) — so this is a Postgres function called via `supabase.rpc()`, not a REST mutation from the client:

1. **Quiet hours** (moved from guardrail G4, §6.4) — current SGT hour must be within `[quiet_hours_start, quiet_hours_end)`. This is the actual send-time check; running it here instead of at draft-generation time means the check reflects the hour the message would really go out, not the hour it happened to be drafted.
2. `MockProvider.send()`
3. Insert the outbound message
4. `touch_count += 1`, `last_outbound_at = now()`, `resolved_at = now()`, `drafts.status = 'approved'` (or `'edited'` if `body` differs from the stored draft)

Skip (`drafts.status = 'skipped'`, `resolved_at = now()`) stays a plain REST PATCH — it changes no cadence state, so there's nothing to protect with a transaction.

`now` override on `generate-drafts` exists so the eval harness can test time-dependent behaviour without mocking clocks (see the guard above).

---

## 9. UI spec

Two routes. Sidebar nav. Neutral, dense, no marketing polish — this is an operator tool.

**`/settings` is cut** (originally a third route — `VoiceProfileForm.tsx`, §1). The demo beat it existed for — "same lead, two voices, visibly different drafts" — doesn't need a settings form to prove; it needs a contrast, and a form is CRUD around the actual point. Instead: seed a second agent with a contrasting voice profile (task 8) and add one eval fixture that runs the same lead+messages through both agents and prints both drafts side by side in the runner's `--verbose` output (task 12). Same checkbox in §12 satisfied, zero UI hours spent. If there's time left after everything else, it's a reasonable thing to add back — see the triage note in §11.

**`/queue`** — the default. Header: `{n} drafts awaiting approval` + a **"Run cadence tick"** button (calls `generate-drafts` for all leads). List of `DraftCard`:
- Lead name · state badge (colour per state) · `21d silent` · source badge
- Strategy chip (`new_listing_hook`)
- Draft body in a WhatsApp-ish bubble, **editable inline** on click
- Buttons: **Approve** · **Edit & Approve** · **Skip** · **Why this?**
- `needs_review` cards render with an amber left border and the failed guardrail rule stated in plain language (including `tone` as a possible value — §6.4).
- Approve / Edit & Approve call `rpc('approve_draft', ...)` (§8); Skip is a plain `PATCH` — see §8 for why they differ.
- Keyboard: `a` approve, `s` skip, `j`/`k` move. Cheap, and it signals you've thought about the daily-use case. First thing to cut if hour 8 looks tight.

**`/leads/:id`** — two columns. Left: message thread, inbound left / outbound right, timestamps. Right: `FactsPanel` — one row per fact showing `key`, `value`, a confidence dot, and the **evidence span quoted with the source timestamp**. Superseded facts collapsed under "history". This panel is the anti-hallucination story made visible; make it look good.

**`TracePanel`** — slide-over. Renders `drafts.trace` as labelled sections in this order: State → Rules evaluated (matched ones highlighted, winner starred) → Strategy → Facts used → Guardrail → Cost & latency → Prompt versions. Raw JSON in a collapsed `<details>` at the bottom.

---

## 10. Eval harness

`pnpm eval` → `packages/eval/src/run.ts`. For each fixture: `truncate leads, messages, lead_facts, drafts cascade` against the local dev schema (not a fresh schema per fixture — schema-per-fixture plus migration replay in local Supabase is seconds of real work per run and buys zero isolation value for a single-tenant demo), insert agent + lead + messages, call `extract-facts`, call `generate-drafts` with the fixture's `now` (service-role auth, so the `now` guard in §8 doesn't reject it), run assertions, write `eval_runs`. Print a table: `fixture | pass | failed assertions | latency | cost`. Exit code 1 if any fail. `--only <id>` and `--verbose` flags — `--verbose` is also where the two-voice comparison (§9) prints its side-by-side output.

### Assertion types (`assertions.ts`)

**Runner-level hard-fail, before any assertion below runs:** if a fixture expects any facts (`facts_extracted` non-empty) but `extract-facts` returns non-200, or returns `inserted == 0 && rejected == 0`, the fixture fails immediately with `pipeline_error`, regardless of what the individual assertions would otherwise say. This exists because `facts_absent` and `no_hallucinated_entities` are pure negatives — a broken pipeline that extracts nothing satisfies both, and F18/F19 are exactly the two fixtures this document calls "the two that matter most." A green `pnpm eval` on a dead extraction path is the failure mode most likely to embarrass a live demo, so it's checked structurally rather than trusted to the fixture author remembering a positive control every time.

1. `facts_extracted` — for each expected `{key, value}`, a matching non-superseded fact exists. Deep-equal on value. **Every fixture using `facts_absent` or `no_hallucinated_entities` must also carry at least one `facts_extracted` entry** — the positive control that proves the pipeline ran, not just that it didn't do the wrong thing.
2. `facts_absent` — listed keys must NOT exist (the anti-inference tests). Where the fixture supplies a `value_not` alongside a key, strengthen to "no fact with this key whose value contains X" — a model that extracts nothing shouldn't pass the anti-inference test for the wrong reason.
3. `strategy_selected` — exact string match on `trace.strategy`.
4. `rule_fired` — exact string match on `trace.rule_fired`.
5. `no_draft` — `outcome == 'suppressed'` and no `drafts` row.
6. `no_hallucinated_entities` — re-runs G3 (with its full normalizer, §6.4) over the produced draft, independently of the pipeline.
7. `draft_contains` / `draft_omits` — case-insensitive substring checks.
8. `tone_acceptable` — the tone-check verdict. **Label this in output as `[soft]`** and exclude it from exit-code failure by default (`--strict` includes it). Be explicit that it's the non-deterministic one.

`rule_fired`-only fixtures (no LLM assertions at all) are cheaper and faster as unit tests in `selectStrategy.test.ts` (task 5) than as eval fixtures — see the fixture cut below.

### Fixtures — `packages/eval/fixtures/`

Shape:
```jsonc
{
  "id": "F01_cold_buyer_21d",
  "now": "2026-07-30T10:00:00+08:00",
  "agent": { "name": "Wei Ling", "max_touches": 4,
             "voice_profile": { "formality": 2, "warmth": 4, "brevity": 4, "emoji_ok": false } },
  "lead": { "name": "Marcus", "source": "propertyguru", "touch_count": 1,
            "created_at": "2026-06-20T09:00:00+08:00" },
  "messages": [
    { "direction": "inbound",  "sent_at": "2026-07-09T14:02:00+08:00",
      "body": "hi saw ur listing, im looking at katong area, budget around 1.5m for a 3 bedder" },
    { "direction": "outbound", "sent_at": "2026-07-09T14:20:00+08:00",
      "body": "Hi Marcus! Sure, I have a few options in D15. When are you looking to move?" }
  ],
  "expect": {
    "facts_extracted": [
      { "key": "districts", "value": ["D15"] },
      { "key": "budget_max", "value": 1500000 },
      { "key": "bedrooms", "value": 3 },
      { "key": "transaction_type", "value": "buy" }
    ],
    "facts_absent": ["timeline"],
    "state": "cold",
    "rule_fired": "gap_fill",
    "strategy": "fill_missing_fact",
    "no_hallucinated_entities": true,
    "tone_acceptable": true
  }
}
```

Build these 12. Write the message bodies yourself in this style — realistic, lowercase, typo-ridden:

| id | scenario | key assertion |
|---|---|---|
| F01 | cold buyer, 21d silent, timeline missing | `gap_fill` → `fill_missing_fact` |
| F02 | cold buyer, all 4 required facts present, 21d | `listing_hook` → `new_listing_hook` |
| F03 | new Meta ad lead, zero outbound | `new_ad_lead` → `instant_qualify` |
| F05 | **"pls stop messaging me"** | `no_draft`, `state=do_not_contact` |
| F07 | **"call me next month, busy now"** | `no_draft`, `snoozed` rule, `snooze_until` set |
| F08 | replied 2 days ago, agent has messaged before (`touch_count > 0`) | `no_draft`, `warm_human_handles` |
| F09 | `touch_count == max_touches` | `no_draft`, `touch_cap` |
| F12 | budget "under 1m" | `budget_max=1000000`, `facts_absent:["budget_min"]` |
| F14 | contradicts budget across two messages | only most recent value survives; positive control on the final value (exercises `superseded_at`) |
| F18 | **"I stay in Tampines, looking to buy in the east"** | positive control: `transaction_type=buy` extracted (proves the pipeline ran); `districts` must NOT be `["D18"]` — the anti-inference trap |
| F19 | thread with NO budget/district at all | positive control: `transaction_type` (or another benign fact) extracted; `no_hallucinated_entities`; draft must not name a price or district |
| F20 | lead asks "what's the price of that unit?" — agent never stated one | draft must not invent a figure; `draft_omits` any `$` |

**Cut from an earlier 20-fixture draft, and why**, so the cut is a decision rather than a shortfall discovered under time pressure:
- **F10 (`last_chance`), F11 (`long_dormant`), F13 (budget range), F06 (`already bought`)** — each asserts only `rule_fired` or a parser branch already covered by `selectStrategy.test.ts` (task 5) or `extract-facts` unit tests. Free, instant, and deterministic there; an LLM-executing fixture is the expensive way to test a pure function.
- **F04 (rental/move-in), F15 (Singlish), F16 (mixed EN/中文), F17 (voice-note noise)** — these mostly measure Sonnet's language capability, not this system's architecture. They'd be the flakiest rows in the suite and the ones you control least. Reasonable to add back once the 12 above are green and stable, not before.

F18 and F19 are the two that matter most. If you only get 6 fixtures done, do F01, F02, F03, F05, F18, F19.

### The planted regression (demo beat #6)

After the harness is green, create `write-v2` which deletes exactly this line from the system prompt:

> `- You may ONLY reference facts present in FACTS below. Do not mention any price, district, date, project name, or unit type that is not there.`

Verify it turns F19 and/or F20 red on `no_hallucinated_entities`. Keep both versions committed behind an env var `WRITE_PROMPT_VERSION=v1|v2` so the demo is a one-line switch, not a live edit. **Confirm this works before the demo, not during it.**

---

## 11. Task list — execute in order

Reordered on review: the eval harness and the planted regression (formerly 15 and 17) move up to 12 and 16, directly after `generate-drafts` (11), instead of behind three UI tasks. The eval runner is the fastest available debugger for the orchestration task, and the harness is the one deliverable the contract calls uncuttable — a rule that protects a task you haven't started yet isn't protection. `/settings` (formerly 16) is cut outright; see §9.

1. `pnpm init` workspaces; scaffold `apps/web` (Vite React TS), `packages/core|llm|eval`; Tailwind + shadcn init; `supabase init` + `supabase start`. Verify `pnpm dev` renders.
2. Write `0001_init.sql` and `0002_rls.sql` exactly as §3. Migrate. Verify RLS is on for all six tables, and that `drafts_one_pending_per_lead` exists.
3. `packages/core`: `types.ts`, `sg-rules.ts` (§4), `facts.ts` (§5). No logic yet.
4. `classify.ts` + `classify.test.ts` (§6.1). All boundary tests pass, including a test that `leads.state` is never written outside `generate-drafts`.
5. `selectStrategy.ts` + tests + `strategy_rules` seed (§6.3, 10 rows — `cooldown_active` is a post-selection function, not a row). Test every row fires when expected and loses when outranked; test the post-selection cooldown check separately; test that a zero-touch `new`+`meta_ad` lead reaches `instant_qualify` rather than being swallowed by `warm_human_handles`.
6. `guardrail.ts` G1–G5 + tests (§6.4 — quiet hours and no-double-send are no longer here, see §6.4 and §8). Write G3's five normalizer tests first — it's the check everything else rests on.
7. `packages/llm/src/call.ts` with usage logging + cost table. `MockProvider` in core.
8. `seed/seed.ts`: 2 agents (the second with a contrasting voice profile, so task 12's two-voice fixture has something real to run against), 6 leads across states (cold-with-gap, cold-complete, new-ad, warm-already-messaged, opted-out, dormant) under the first agent, ~40 messages total in the fixture voice. Reuse one lead+thread under the second agent for the voice-contrast fixture.
9. `extract-facts` edge function + prompt 7.1 + the four-layer evidence enforcement (verbatim substring, server validation, numeric cross-check, superseding — §5) + superseding. Test on all 6 seeded leads; confirm at least one `evidence_mismatch` and one `value_evidence_mismatch` rejection are both possible by stubbing.
10. `ingest-inbound` + opt-out/snooze keyword detection (§6.2) + tests.
11. `generate-drafts`: orchestrate classify → selectStrategy → write (7.2) → guardrail → toneCheck (7.3). Build the full `trace` object per §8, including the pending-draft skip and the `now`-override guard. This is the core deliverable — get the trace shape exactly right.

    **Checkpoint: freeze `extract-v1`, `write-v1`, `tone-v1` here.** No prompt edits until task 16 is done — an edit after 12 goes green invalidates the baseline the planted regression demos against.
12. `packages/eval`: runner + assertions + the 12 fixtures from §10, starting with F01, F02, F03, F05, F18, F19. Get green. This includes the two-voice comparison fixture from task 8, printed side by side in `--verbose` output.
13. `/queue` + `DraftCard` + approve/edit/skip mutations (approve calls `approve_draft`, §8) + `Run cadence tick`.
14. `/leads/:id` thread + `FactsPanel` with visible evidence spans.
15. `TracePanel` slide-over.
16. Plant `write-v2`, verify the regression turns exactly F19 and/or F20 red on `no_hallucinated_entities`, revert to v1.
17. `README.md`: architecture diagram (mermaid), the determinism-boundary table from §6 (stated as: *the pipeline makes it structurally hard for the model to invent an entity — a price, district, or date with no textual source — and impossible for it to invent a schedule; it can still misread a value, which is what human approval is for*), **"What I cut and why"** (§settings, G4/G5, the `triggerWhen` DSL, 20→12 fixtures), **"What I'd do in week one with real data"** (per-fact precision/recall against ~200 anonymized real threads, not pass/fail), the RLS-is-shipped-but-unexercised note (§8 q5-style), and the open questions for the founder — leading with the `warm_human_handles` threshold, since that's the decision most likely to get challenged (see review).

**Triage if behind:** skip 15 (`TracePanel`) first, then simplify 14 to thread + a raw evidence list (drop `FactsPanel` visual polish, keep the substance). **Never skip 12 (eval) or 16 (the planted regression)** — those are the two deliverables that can't be faked in a live demo, and they no longer sit at the end of the list where "never skip" would be an empty promise.

---

## 12. Definition of done

- [ ] `pnpm test` green — `classify`, `selectStrategy`, `guardrail`, `facts` all covered, including G3's five normalizer tests and the post-selection cooldown check
- [ ] `pnpm eval` green on all 12 fixtures (§10), including F18 and F19, and none of them pass via the `pipeline_error` hard-fail masking a broken extraction
- [ ] Every fact in the UI shows a verbatim evidence span with a timestamp
- [ ] F05-style lead produces zero drafts and the trace names the rule
- [ ] Clicking "Run cadence tick" twice does not double the queue — `drafts_one_pending_per_lead` holds
- [ ] Same lead + two voice profiles produces two visibly different drafts, via the eval fixture from task 8/12 (no `/settings` UI — see §9)
- [ ] `WRITE_PROMPT_VERSION=v2 pnpm eval` fails on F19 and/or F20, with a named assertion — confirmed with prompts frozen since task 11, not edited live
- [ ] Trace panel shows cost and latency for every draft, and `facts_referenced_by_model` alongside `facts_used`
- [ ] RLS policies exist on all tenant tables; README states plainly that they ship but are not exercised by the demo (service-role + hardcoded `agent_id`)
- [ ] `sg-rules.ts` carries no "unverified numbers" banner over data that isn't there — just the one-line "no policy numbers, by design" note
- [ ] README contains the cuts (including `/settings`, G4/G5, the `triggerWhen` DSL, and the fixture count), the week-one plan, and the founder questions, leading with the `warm_human_handles` threshold