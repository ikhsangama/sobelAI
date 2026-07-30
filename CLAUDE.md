# CLAUDE.md — Revive

## Authority

**`planning-overview.md` is the implementation contract.** Read the relevant § in full before starting any task. Everything in it is a decision already made.

| File | Role |
|---|---|
| `planning-overview.md` | **The contract.** Authoritative. Post-architectural-review: 17 tasks, `/settings` cut, eval at task 12, 12 fixtures, guardrails G1–G5. |
| `context.md` | Background on *why* — the briefing that commissioned the review. Not a spec. Never implement from it. |
| `issueN.md` | Task N's working brief. One retained file per contract task. |

If any other document, memory, or prior message conflicts with `planning-overview.md`, the contract wins. Older drafts of this spec exist in the wild and differ on ~12 load-bearing points (React 18, `MAX_DRAFT_CHARS = 480`, G1–G7, 11 strategy rules, a client-side `PATCH` approve, 3 routes, 20 fixtures, 18 tasks). Those are all **stale**.

---

## Rules for you (Claude Code)

Reproduced verbatim from `planning-overview.md` — these apply on every turn.

1. **Do not invent business logic.** Strategy rules, state thresholds, banned phrases, and required-fact sets are specified literally in the contract. If something is genuinely unspecified, add a `// SPEC-GAP:` comment and pick the simplest option — do not silently design.
2. **Do not add features.** No auth UI, no billing, no real WhatsApp send, no broadcasts, no dark mode toggle, no landing page. Scope creep is the main failure mode here.
3. **Deterministic stages must be pure functions with unit tests.** `classify()` and `selectStrategy()` take plain objects and return plain values. No DB calls, no LLM calls, no `Date.now()` inside them — pass `now` in.
4. **Every LLM call goes through `packages/llm/src/call.ts`** which logs `{stage, model, prompt_version, input_tokens, output_tokens, latency_ms, cost_usd}`. No direct SDK calls anywhere else.
5. **Never fabricate facts.** See the evidence rule in §5. This is the single most important correctness property in the repo.
6. Work through §11 in order. Commit after each numbered task with the task number in the message.

## Rule 7 — scope boundary

All work stays inside this repository root. **Never create, edit, or delete a file outside it.** In particular, do not recreate a `CLAUDE.md` in any parent directory — one used to live there carrying the stale pre-review contract, and it was removed deliberately.

---

## Current state

- **Task 1 complete** — pnpm workspace (`@revive/web|core|llm|eval`), React 19 + Vite 8 + Tailwind v4 + shadcn, `supabase init` done.
- **Task 2 complete** — `0001_init.sql` + `0002_rls.sql` applied and verified (7 tables, 7 policies, 4 enums, the partial unique index proven to enforce, RLS proven to block anon and admit service-role). See `issue2.md`.
- **Task 3 complete** — `packages/core/src/{types,sg-rules,facts}.ts` written; `sg-rules.ts`/`facts.ts` diffed byte-identical against §4/§5, `types.ts` derived from the schema with 3 `// SPEC-GAP:` notes. `pnpm typecheck`/`test`/build all green. See `issue3.md`.
- **Task 4 complete** — `classify.ts` + `diffDays` (byte-identical against §6.1); `classify.test.ts` (boundaries at 2/3, 7/8, 45/46 days) and a `leads.state`-has-one-writer guard test, verified against a planted violation before being trusted. `SCAFFOLD_OK`/`scaffold.test.ts` retired. See `issue4.md`.
- **Task 5 complete** — `selectStrategy.ts` (closed 6-key `match` schema, since `strategy_rules.match` is jsonb but §6.3 writes conditions as prose — see the amendment log for the new one), `0003_strategy_rules.sql` (10 rows, migration not seed — cadence can't run without it), 59 tests incl. a drift check proving the SQL and the TS constant can't diverge. Documents a real reachability gap: a `meta_ad` lead who submits the form gets `state=warm` from `classify()`, so `new_ad_lead` (`state=='new'`) never fires — pinned by a test, not silently fixed, and flagged for the README. See `issue5.md`.
- **Task 6 complete** — `guardrail.ts` G1–G5, no LLM/quiet-hours/no-double-send (those moved or were deleted on review). Found and fixed two real bugs in §6.4's literally-specified G3 regex (amendment A5): a missing word-boundary that misreads ordinary phrases like "3 months" as invented numbers and defeats the year whitelist on `market_update` drafts, and a missing comma-strip that lets `$1,200,000`-style prices bypass G3 entirely. 101 tests. See `issue6.md`.
- **Task 7 complete** — `packages/llm/src/call.ts` (rule-4 chokepoint: usage logging `{stage, model, prompt_version, input_tokens, output_tokens, latency_ms, cost_usd}`, `claude-sonnet-4-6` cost table that throws on an unpriced model, JSON-fence stripping, cross-runtime `ANTHROPIC_API_KEY` read via `globalThis` for Deno/Node) + `MockProvider` in core (pure — `send()` mints an id and does no I/O per amendment A1; `parseWebhook` throws on a malformed payload rather than returning `[]`). 13 new tests (126 total). See `issue7.md`.
- **`0004_approve_draft.sql` next** — unblocked by task 7 per amendment A1; then task 8 (`seed/seed.ts`).

Update this section on each task commit.

### Local environment note

The `supabase` CLI on this machine was a stale standalone binary (2.54.11) that couldn't parse the `config.toml` this repo ships (generated by a much newer CLI). Upgraded in place to v2.110.0 — installed as two files, `supabase` and `supabase-go`, both required in the same directory (the CLI resolves its companion binary relative to its own path, not via `$PATH`). Both live in `~/.local/bin/`, which sits ahead of `/usr/local/bin` on `$PATH` — no sudo was available to touch `/usr/local/bin` directly. If `supabase` commands start failing with a config-parse or "supabase-go binary not found" error again, check that installation first.

---

## Amendments

Resolutions to genuine gaps in the contract. Decided, not open. Do not re-litigate.

### A1 — `approve_draft` ships as `0004_approve_draft.sql`, after task 7

§8 specifies `approve_draft` as a Postgres function doing four things atomically, step 2 being `MockProvider.send()`. plpgsql cannot invoke TypeScript, and `MockProvider` does not exist until task 7.

**Resolution:** Task 2 ships `0001` + `0002` only. `0004_approve_draft.sql` (renumbered from `0003` — task 5 needed that slot for `strategy_rules`, since the rules table is reference data the app can't run without and belongs in a migration, not `seed.ts`) lands after task 7 and before task 13 (queue UI). The plpgsql function performs the mock send inline — generating a `provider_msg_id` — while `MockProvider` remains the TS-side seam used by edge functions and the eval harness. Single-transaction atomicity, §8's whole reason for replacing the client `PATCH`, is preserved.

### A2 — "six tenant tables" is a miscount; it is 5 + 2

§3 says "enable RLS on all six tenant tables", then describes 5 tenant tables (`agents`, `leads`, `messages`, `lead_facts`, `drafts`) and 2 global ones (`strategy_rules`, `eval_runs`) — 7 total.

**Resolution:** RLS enabled on **all 7**. `tenant_isolation` policy on the 5 tenant tables. A `for select using (true)` read-only policy on the 2 global tables; writes fall through to service-role bypass. Carry a `-- SPEC-GAP:` note in `0002_rls.sql`. Do not try to make the count come out to six.

### A3 — the SQL seed hook is disabled; seeding is TypeScript at task 8

`supabase/config.toml` ships with `sql_paths = ["./seed.sql"]` pointing at a file that does not exist, while §1 specifies `supabase/seed/seed.ts`.

**Resolution:** set `db.seed.enabled = false` so `supabase db reset` does not warn or fail on the missing file. Task 8's `seed.ts` runs as a script.

### A4 — `strategy_rules.match` uses a closed six-key schema, not an expression language

The column is `jsonb`, but §6.3 writes its ten conditions as prose expressions (`state in ['cold','dormant'] && fact_gaps.length > 0`). Nothing in the contract defines what those look like as JSON or how `selectStrategy()` evaluates them.

**Resolution:** six keys — `state_in`, `source_eq`, `snoozed`, `touch_count`, `fact_gaps_len`, `days_silent` — ANDed when present; numeric keys take `eq`/`gt`/`gte`/`lt`/`lte` against a literal or `{"agent":"max_touches"}` (with an optional `offset`). An unrecognised key or operator **throws** rather than being ignored, since a silently-vacuous condition on a priority-100 suppression rule would silence the whole queue. This is deliberately not a general parser — §4 already rejected one condition-DSL (`ELIGIBILITY_TOPICS.triggerWhen`) as unneeded scope, and that reasoning holds here for the same reason: a fixed, closed schema keeps "rules are editable in SQL without a deploy" true for *values*, while a new predicate *kind* still needs a code change. State that distinction plainly in the README.

**Also recorded here:** a real reachability gap in §6.3, found by tracing `classify()` rather than reading the prose. A `meta_ad` lead who submits the ad form generates an inbound message, so `classify()` returns `warm`, not `new` — and `new_ad_lead` requires `state == 'new'`. `warm_human_handles` correctly stands down (`touch_count > 0` is false for a zero-touch lead), but nothing else matches, so the lead that most needs qualifying gets `no_rule_matched` instead of `instant_qualify`. Implemented literally per contract rule 1 rather than silently patched; pinned by a test in `selectStrategy.test.ts` that says explicitly not to "fix" it. Open question for the founder — see the README once it exists.

### A5 — §6.4's literal G3 regex has two bugs, both fixed and marked `// SPEC-GAP:` in `guardrail.ts`

§6.4 specifies G3's number normalizer literally, deliberately, so an implementer doesn't improvise the check the anti-hallucination story rests on. Running it rather than reading it surfaced two real defects.

**Bug A — the suffix has no word boundary.** `/(\d+(?:\.\d+)?)\s*(k|m|mil|million|psf)?/gi` lets the `m` alternative match the leading letter of the *next word*: "3 months" → `3000000`, "900 metres" → `900000000`, "5 mins" → `5000000` — all ordinary phrasings, all flagged as invented numbers. Worse, "the 2026 market has been quiet" defeats step 3's own year whitelist: a year is only whitelisted while *bare*, and the stray `m` from "market" stops it being bare, breaking the exact `market_update` false-positive step 3 exists to prevent.

**Resolution:** add a negative lookahead — `(?![a-z])` after the suffix group — so a suffix can't be followed by more letters.

**Bug B — no comma handling, which fails open, not with noise.** `$1,200,000` (the ordinary way a price is written here) splits into `1`/`200`/`000`, all under step 4's ≥1000 floor, so G3 checks nothing and a fabricated price passes silently.

**Resolution:** strip thousands separators (`text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')`) before matching, so "$1,200,000" reads as one `1200000` token.

Both fixes and both regression tests (including an end-to-end `guardrail()` test proving the `$1,200,000`-style bypass now fails the draft) are in `guardrail.test.ts`. Bug B is the more serious of the two — it's a hole in the guardrail, not noise from it.

---

## Conventions

- Workspace packages: `@revive/web`, `@revive/core`, `@revive/llm`, `@revive/eval`.
- `packages/core` has **zero runtime dependencies** and exports raw `.ts` from `./src/index.ts`. Deno edge functions import it from source starting at task 9. Never give it a build step or a `dependencies` key.
- Tailwind v4 — no `tailwind.config.js`, no `postcss.config.js`. If you are writing `@tailwind base;` you have gone wrong.
- Migrations use the contract's literal names (`0001_init.sql`, `0002_rls.sql`), not the CLI's timestamp format.
