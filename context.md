# context.md — Briefing for Architectural Review

**You are being asked to review, not to build.** Read this file first, then review `CLAUDE.md` (the implementation contract) and optionally `SobelAI-1Day-MVP-PRD.md` (the rationale document). Your output should be a critique, not code.

---

## 1. What this actually is

This is **not** a production system. It is a **hiring artifact**.

A developer is applying for a **Founding Engineer (Full-Stack / AI)** role at SobelAI, a Singapore startup. The founder has reached out with more detail on requirements. The developer will build a demo in **one day (~10 focused hours, solo, using Claude Code for implementation)** and present it.

Three consequences that should shape your entire review:

1. **The founder already has a working product with daily users.** This build cannot and must not try to be a better SobelAI. Anything in `CLAUDE.md` that reads as "reimplementing their product" is a scoping error.
2. **The evaluated quality is judgment, not completeness.** A narrow slice with defensible architecture beats broad coverage. If `CLAUDE.md` trades depth for feature count anywhere, flag it.
3. **The developer must be able to defend every line under questioning.** Cleverness they can't explain is a liability. Flag any design that is hard to explain out loud in 60 seconds.

---

## 2. The company and problem domain

**SobelAI** — a WhatsApp-based AI assistant for individual property agents in Singapore. Its pitch: agents juggle hundreds of WhatsApp leads and lose good ones to silence, because nobody followed up at the right moment with the right message. The product re-engages quiet leads with personalized on-brand follow-ups, qualifies inbound ad leads, and passively builds a profile of what each lead wants — **while the agent approves every message before it sends.**

Market context: Singapore has 10,000+ registered property agents (CEA-licensed), a fragmented market where each agent is effectively a solo business. Lead sources are Meta lead-gen ads, 99.co, and PropertyGuru.

**Regulatory texture that matters architecturally:** agents are CEA-registered salespersons. An AI drafting messages on their behalf that makes eligibility or financial claims is a real liability, not a hypothetical one. This is why the design treats "agent approves before send" as both a product and a compliance property.

---

## 3. What the job description asks for (the scoring rubric, effectively)

Verbatim priorities from the JD, in its own order:

1. **The AI message pipeline** — a multi-stage system (classify → select strategy → write → guardrail) deciding *when* to follow up, *what* to say, *how* to say it in each agent's voice. Blends deterministic rules with LLM stages; handles warm/cold/new lead states, cadence scheduling, per-agent style profiles. The JD explicitly names *"a constant, fascinating tension between determinism (reliability, cost, latency) and LLM judgment (nuance, personalization) — you'll be the one drawing those lines."*
2. **Lead understanding** — extract structured facts (budget, areas, intent, eligibility) from messy WhatsApp chatter **without hallucinating**; a qualification loop driving ad leads to qualified/disqualified/handed-off.
3. **Messaging infrastructure** — multi-provider WhatsApp (Unipile + Meta Cloud API coexistence), lead-source ingestion, webhooks, anti-spam-classifier scheduling that keeps agents' numbers healthy.
4. **Eval and reliability** — *"'did the AI write a good message?' becomes a measurement problem… the eval harness, prompt-regression testing, and observability… is wide-open green field — and arguably the highest-leverage work in the company."*
5. **The product surface** — React/Supabase app: inbox, follow-up queue, broadcasts, lead CRM, settings.

Also stated: they want strong product instincts ("what does the agent actually need?" before "what's the cleanest abstraction?"), someone who knows *"the difference between 'scrappy' and 'sloppy'"*, and they *"value the judgment behind the stack over the stack itself — bring strong opinions, hold them loosely."*

**Mandated stack:** React 18 + TypeScript + Vite · Tailwind + shadcn/Radix · React Query · Supabase (Postgres, RLS, Edge Functions) · LLM pipelines (OpenAI/Claude) · pnpm monorepo. Deviating from this is a scoring loss, not a technical choice.

---

## 4. Hard constraints

| Constraint | Value |
|---|---|
| Time | ~10 hours, one calendar day, one developer |
| Implementation method | Claude Code doing most typing; developer directing and reviewing |
| Stack | Fixed (see above) — non-negotiable |
| Real WhatsApp send | **Out.** Unipile/Meta onboarding takes days and proves nothing about judgment |
| Auth / multi-tenant UI | Out (but RLS policies ship anyway) |
| Broadcasts, billing, 99.co/PropertyGuru ingestion, real cron, mobile | Out |
| Deliverables | Repo · README · 3-min Loom · one page of questions for the founder |

---

## 5. The two strategic bets `CLAUDE.md` makes

Understand these before critiquing, because most of the design follows from them.

**Bet 1 — Skip WhatsApp, ship the seam.** Build against a `MessagingProvider` interface with only a `MockProvider` implementation, and say so explicitly. The claim: showing where Unipile and Meta Cloud would coexist demonstrates more architectural judgment than a connected phone number.

**Bet 2 — Build the eval harness even though a demo doesn't require one.** The JD calls it the highest-leverage work in the company and wide-open greenfield. The plan includes a *planted regression*: an env-var-switched prompt variant (`write-v2`) that removes the anti-hallucination constraint, causing specific fixtures to fail — demonstrated live as the closing beat.

The stated ordering rule is: **eval is never cut; voice profiles die first.**

---

## 6. The central architectural position (attack this hardest)

> **The LLM never decides *whether* or *when* to send. It decides only *what to say* and *how to say it*. Everything schedule-shaped is deterministic, inspectable, and unit-testable.**

Implemented as four stages:

| Stage | Owner | Mechanism |
|---|---|---|
| 1. Classify lead state | Deterministic | Pure function over timestamps → `new`/`warm`/`cold`/`dormant`/`handed_off`/`do_not_contact` at 2/7/45-day boundaries |
| 2. Select strategy | Deterministic | Priority-ordered `strategy_rules` **table in Postgres** → one of 7 strategies. Editable without deploy |
| 3. Write message | LLM | Inputs: strategy + extracted facts + last 6 messages + agent voice profile |
| 4. Guardrail | Hybrid | 7 deterministic checks (G1–G7) first, then one cheap LLM tone pass |

**Anti-hallucination mechanism (three layers):** every extracted fact must carry a verbatim `evidence` substring of its source message; server-side validation discards any fact whose evidence isn't literally present; guardrail G3 cross-checks every number, date, and district in the generated draft against the fact set.

**One notably opinionated rule:** `warm_human_handles` at priority 80 — if a lead replied within 7 days, the AI produces *nothing*. This is an interpretation of the product promise ("the agent stays in control of every real conversation") encoded as a rule rather than a prompt instruction.

---

## 7. Document map

| File | Role |
|---|---|
| `context.md` | This briefing |
| `SobelAI-1Day-MVP-PRD.md` | Rationale, scope reasoning, hour-by-hour plan, demo script. Written for the founder to read |
| `CLAUDE.md` | **The artifact under review.** Literal implementation contract for Claude Code: full SQL DDL, RLS policies, `sg-rules.ts` contents, all 11 strategy rule rows, classify thresholds, guardrail rules G1–G7, complete prompt text for all three LLM stages, API request/response contracts, UI spec, 20 eval fixtures, 18-task ordered build list, definition of done |

`CLAUDE.md` is deliberately literal because the failure mode being defended against is Claude Code *inventing plausible-but-wrong business logic* in the exact places that carry the signal — strategy rules, Singapore-specific thresholds, guardrail bans, and adversarial fixtures.

---

## 8. Known-weak areas — please interrogate these specifically

The author already suspects these. Confirm, refute, or sharpen:

1. **Is 10 hours honest?** 18 tasks including three edge functions, a 4-stage pipeline, three UI routes, and a 20-fixture eval harness. Where does the estimate break first? Is the stated triage order (drop settings → drop trace panel → trim fixtures to six, never drop eval) the right one?
2. **Is a 4-stage pipeline over-engineered for a one-day demo?** Would 3 stages (drop the LLM tone check, keep deterministic guardrails only) demonstrate the same judgment at 30% less cost and latency? The counter-argument is that hybrid guardrails are themselves the interesting design claim.
3. **Is `warm_human_handles` correct or is it a misread?** It means the AI stays silent on any lead who replied in the last 7 days. Defensible product judgment, or does it gut the demo by suppressing the most interesting conversations?
4. **Guardrail G3 is a regex-and-numeric-tolerance heuristic** ("every number ≥1000, `$`-amount, `DXX`, or date-like token in the draft must exist in the fact set, ±2% tolerance"). How does it fail? False positives on innocuous numbers? Bypasses via spelled-out numbers ("one point two million")? Is a heuristic here honest-scrappy or sloppy?
5. **RLS with a hardcoded `agent_id` and service-role access is arguably theater.** The claim is that shipping policies day-one avoids the classic retrofit wound. Is that a genuine signal or does it invite "you wrote policies you never exercised"?
6. **Append-only `lead_facts` with `superseded_at`.** Real value (auditable fact evolution, supports the "passively builds a profile" claim) or complexity that costs an hour and buys nothing in a demo?
7. **Fixture realism.** 20 hand-written fixtures cannot represent real agent chatter, and the author plans to admit this and ask the founder for anonymized real threads. Is that framing a strength or does it undercut the eval demo?
8. **F18, the anti-inference fixture** — *"I stay in Tampines, looking to buy in the east"* must extract `current_housing` but must **not** extract D18 as a target district. Is this assertion reliably testable, or is it too model-dependent to be a stable regression test?
9. **The planted regression as a demo beat.** Env-var-switched `write-v2` removing one prompt line. Is this a compelling 45-second moment, or does deliberately breaking your own system read as a gimmick?
10. **Singapore rule values are explicit placeholders** with `VERIFY BEFORE RELYING` comments, because policy numbers change and the author's knowledge has a cutoff. They only ever gate *which clarifying question to ask*, never advice. Is that handled acceptably, or does shipping unverified numbers — however flagged — read badly to a Singapore founder who knows the real ones?
11. **`now` is injected into `generate-drafts` as a request parameter** so the eval harness can test time-dependent behaviour without clock mocking. Clean, or a production-unsafe testing seam?
12. **Anything the founder would wince at.** This is the most valuable thing you can find. What in `CLAUDE.md` would make an experienced founder-engineer think *this person hasn't built this kind of system before*?

---

## 9. What a useful review looks like

**Do:**
- Attack the determinism/LLM boundary in §6 on its merits — that's the load-bearing claim
- Find the ordering error in the 18-task list that causes a wasted hour
- Find the spec ambiguity that will cause Claude Code to invent logic despite the instruction not to
- Find the missing test that would let a real bug through
- Tell the author which single decision they should be most prepared to defend, and what the strongest counter-argument to it is
- Propose *subtractions*. Cutting something to make the remainder sharper is the highest-value note here

**Do not:**
- Suggest features (auth UI, broadcasts, real WhatsApp, dashboards, notifications). Scope creep is the primary failure mode and the exclusions in §4 are deliberate
- Suggest stack changes. The stack is fixed by the employer
- Suggest production hardening (CI/CD, monitoring, load testing, error budgets) except where the *absence* would itself be a judgment red flag worth mentioning in the README
- Rewrite the prompts wholesale — critique specific lines instead, since each has a version string tied to eval regression tracking
- Optimize for completeness. Ten polished minutes of demo beats a broad half-working system

**Output format requested:** (a) the three most serious problems, ranked, each with a concrete fix; (b) a verdict on the §6 boundary — sound, or what's wrong with it; (c) proposed subtractions; (d) the one decision most likely to be challenged in the interview, with the strongest counter-argument to it; (e) anything in §8 you think is a non-issue, so the author stops worrying about it.

---

## 10. Definition of success for the underlying build

- Messy WhatsApp thread → structured facts, each showing a verbatim evidence span with timestamp
- Two leads in different states → different strategies → visibly different messages
- A trace panel explaining one draft end to end: state, rule fired, strategy, facts used, guardrail verdict, cost, latency, prompt versions
- A "stop messaging me" lead produces **zero** drafts, with the suppression rule named in the trace
- Same lead + two voice profiles → two visibly different drafts
- `pnpm eval` green; `WRITE_PROMPT_VERSION=v2 pnpm eval` red on a named fixture and assertion
- README containing the architecture diagram, the boundary rationale, **what was cut and why**, a week-one plan with real data, and open questions for the founder

The last item is deliberate: the intent is for the demo to read as a colleague opening a conversation, not a candidate presenting answers.