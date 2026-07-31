# Task 15 — `TracePanel`, the decision trace slide-over

> **§11 task 15:** `TracePanel` slide-over.

§9 specifies it in two sentences:

> **`TracePanel`** — slide-over. Renders `drafts.trace` as labelled sections in this order: State →
> Rules evaluated (matched ones highlighted, winner starred) → Strategy → Facts used → Guardrail →
> Cost & latency → Prompt versions. Raw JSON in a collapsed `<details>` at the bottom.

The **"Why this?"** button already sits on every `DraftCard`, rendered and disabled with
`title="Trace panel lands in task 15"`. This task turns it on.

Everything the panel shows already exists — `generate-drafts` has been writing the full §8 trace to
`drafts.trace` since task 11. **No new queries, no new tables, no LLM calls.** `DraftCard` already
holds `draft.trace` in memory. This task is presentation only.

**Scope boundary.** Read-only. Do not add re-run/regenerate buttons, do not make the trace
editable, do not add a trace view to `/leads/:id`. §9 attaches this to the queue card and nowhere
else.

> ⚠️ **§11's triage rule names this task first to cut:** *"skip 15 (`TracePanel`) first, then
> simplify 14… **Never skip 12 (eval) or 16 (the planted regression)**."* If time is short, task 16
> (the planted `write-v2` regression) and task 17 (the README) matter more to the demo than this
> does. Check that 16 and 17 are on track before starting.

---

## Read this before you start

Every claim below was checked against the real `drafts.trace` rows in the local database, or
against `supabase/functions/generate-drafts/index.ts` where the shape depends on a branch the
current data doesn't happen to exercise.

### Seven traps

---

**Trap 1 — "matched" and "winner" are two different things. Both are real, and they differ.**

§9 says *"matched ones highlighted, winner starred"* — two distinct visual states, because
**several rules can match at once while only one wins on priority.** Verified against all four real
traces currently in the database:

```
draft a9ff1586…  rule_fired=gap_fill      matched rules: 2
draft c749d930…  rule_fired=gap_fill      matched rules: 2
draft 6dbfee5c…  rule_fired=new_ad_lead   matched rules: 1
draft 50104979…  rule_fired=gap_fill      matched rules: 2
```

In the two-match traces, both `gap_fill` (priority 60) and `gentle_check_in` matched; `gap_fill`
won. So:

- **highlighted** ⇔ `entry.matched === true`
- **starred** ⇔ `entry.name === trace.rule_fired`

Collapsing these into one style throws away the single most interesting thing in the panel — that
the engine considered several plays and picked one on priority.

---

**Trap 2 — `usage.tone` and `prompt_versions.tone` are ABSENT when the deterministic guardrail failed.**

The tone check runs only after G1–G5 pass, so a draft that failed the deterministic half never made
that call and has no tone numbers at all. From `generate-drafts/index.ts` — the trace is built with
write-only usage first:

```ts
const trace: Record<string, unknown> = {
  ...baseTrace,
  facts_referenced_by_model: written.facts_referenced ?? [],
  usage: { write: { latency_ms: writeUsage.latency_ms, cost_usd: writeUsage.cost_usd } },
  prompt_versions: { write: writePrompt.version },
}

const g = guardrail(body, facts as never)
if (!g.pass) {
  trace.guardrail = { deterministic: 'fail', tone: null, failed_rule: g.failedRule, detail: g.detail }
  const draft_id = await saveDraft(lead, body, decision.strategy, trace, 'needs_review')
  // ...tone usage is never added
}
```

Only on the tone path does it become `usage = { write, tone }`. Rendering
`{trace.usage.tone.latency_ms} ms` unguarded prints `undefined ms` on exactly the drafts an
operator most wants to inspect. Every usage/prompt-version read needs `?.`.

---

**Trap 3 — the guardrail object has three different shapes. Handle all three.**

Straight from the three branches in `generate-drafts`:

| Outcome | `trace.guardrail` |
|---|---|
| pass | `{ deterministic: 'pass', tone: 'pass', failed_rule: null }` |
| deterministic fail | `{ deterministic: 'fail', tone: null, failed_rule: 'G3', detail: 'number 900000 is not in the fact set' }` |
| tone fail | `{ deterministic: 'pass', tone: 'fail', failed_rule: 'tone', reasons: ['too pushy', …] }` |

Note `detail` (a string, deterministic failures) and `reasons` (a string array, tone failures) are
**different keys** and never both present. All four traces in the database right now are the
happy-path shape, so the other two will not appear in casual testing — Step 5 shows how to plant
them.

---

**Trap 4 — a suppressed lead has no `drafts` row, so the panel never sees one. Don't build that empty state.**

`generate-drafts` returns `draft_id: null` and writes nothing for `outcome: 'suppressed'`, and the
`skipped` branch points at the *existing* pending draft without creating a row:

```ts
if (decision.strategy === 'suppress') {
  results.push({ lead_id: lead.id, draft_id: null, outcome: 'suppressed', trace: baseTrace })
  continue
}
```

So the only traces reachable from a `DraftCard` are those of real `drafts` rows — `pending`,
`needs_review`, and resolved ones. A suppressed lead's trace exists only in the
`generate-drafts` HTTP response, which the UI does not persist. Don't write "this lead was
suppressed" UI here; it is unreachable.

---

**Trap 5 — `facts_used` and `facts_referenced_by_model` are frequently both empty. Render "none", not blank.**

Verified: all four real traces have `"facts_used": []` and `"facts_referenced_by_model": []`,
because those leads had no extracted facts when the draft was generated. An empty `.join(", ")`
renders as an invisible empty string and the section looks broken.

This pairing is a **§12 definition-of-done checkbox** — *"Trace panel shows cost and latency for
every draft, and `facts_referenced_by_model` alongside `facts_used`"* — so both lists must be
present and distinguishable even when empty.

§8 explains why they are shown side by side:

> `facts_used` is what `selectStrategy`/`fill_missing_fact` determined were relevant;
> `facts_referenced_by_model` is the `facts_referenced` array the write prompt actually returned.
> **A model that references a fact outside `facts_used` is a signal worth seeing in the trace panel**
> even though it isn't (yet) a hard failure.

Step 3 renders that divergence in amber. That is the point of the section, not decoration.

---

**Trap 6 — `drafts.trace` is typed `Record<string, unknown>`. There is no `Trace` type to import.**

`packages/core/src/types.ts` types it loosely on purpose, with a comment saying the shape is
specified in §8 and lands "at task 11, when generate-drafts actually builds one" — task 11 built it
but never named it. `packages/eval/src/run.ts` has its own narrow partial `TraceShape` for the two
fields it needs.

**Do not try to unify those.** Declare the shape locally in `TracePanel.tsx` (Step 2), all fields
optional, and cast once at the boundary. A cross-package type refactor is not what this task is.

---

**Trap 7 — the usual three web-app tsconfig rules.**

`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`. An unused import is a build failure;
every type-only import must say `import type`.

---

### Conventions

- `@/` → `apps/web/src/`. Tailwind v4 utilities only; **do not run the shadcn CLI** (network +
  rewrites `index.css`). Everything below is written out in full.
- §1 puts this file at `apps/web/src/features/trace/TracePanel.tsx`. Keep that path.

---

## Step 1 — no new dependencies

The slide-over is a fixed-position panel plus a backdrop. `radix-ui` is already a dependency but its
Dialog is not set up here, and pulling it in for one panel is more moving parts than the panel
itself. Hand-roll it: `<div>` backdrop, `<aside>` panel, Escape-to-close, click-outside-to-close.

Nothing to install. Move on.

---

## Step 2 — `apps/web/src/features/trace/TracePanel.tsx`

```tsx
import { useEffect } from "react"
import { cn } from "@/lib/utils"

/**
 * SPEC-GAP: §8 specifies this shape in full but no named type exists anywhere
 * in the repo — `DraftRow.trace` is `Record<string, unknown>` (types.ts says
 * so deliberately), and packages/eval/src/run.ts declares its own narrow
 * partial for the two fields it reads. Declaring it here, locally and
 * all-optional, keeps that decision unchanged: this is a presentation
 * boundary cast, not a new shared contract (trap 6).
 *
 * Every field is optional because the trace genuinely varies by branch —
 * see traps 2 and 3.
 */
export interface TraceShape {
  state?: string
  state_inputs?: {
    days_since_inbound?: number | null
    touch_count?: number
    opted_out?: boolean
  }
  rule_fired?: string
  rule_priority?: number
  rules_evaluated?: { name: string; matched: boolean }[]
  strategy?: string
  fact_gaps?: string[]
  facts_used?: string[]
  facts_referenced_by_model?: string[]
  guardrail?: {
    deterministic?: "pass" | "fail" | null
    tone?: "pass" | "fail" | null
    failed_rule?: string | null
    /** Deterministic failures only (G1–G5). */
    detail?: string
    /** Tone failures only — the model's own words, copied verbatim (§6.4). */
    reasons?: string[]
  }
  usage?: {
    write?: { latency_ms?: number; cost_usd?: number }
    tone?: { latency_ms?: number; cost_usd?: number }
  }
  prompt_versions?: { write?: string; tone?: string }
  /** Present only when the winning rule was inside its own cooldown (§6.3). */
  suppressed_by_cooldown?: string
  /** Present only on the idempotency skip path (§8). */
  skipped_reason?: string
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-neutral-200 px-5 py-4 first:border-t-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function KeyList({ items, tone }: { items: string[]; tone?: "amber" }) {
  // Trap 5 — empty arrays are the common case; never render an empty string.
  if (items.length === 0) return <span className="text-sm text-neutral-400">none</span>
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((k) => (
        <span
          key={k}
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-xs",
            tone === "amber"
              ? "border-amber-300 bg-amber-50 text-amber-800"
              : "border-neutral-200 bg-neutral-50 text-neutral-700",
          )}
        >
          {k}
        </span>
      ))}
    </div>
  )
}

function fmtCost(n: number | undefined): string {
  return n === undefined ? "—" : `$${n.toFixed(6)}`
}

function fmtLatency(ms: number | undefined): string {
  if (ms === undefined) return "—"
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

function Verdict({ value }: { value: "pass" | "fail" | null | undefined }) {
  if (value === undefined || value === null)
    return <span className="text-sm text-neutral-400">not reached</span>
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        value === "pass" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700",
      )}
    >
      {value}
    </span>
  )
}

interface Props {
  trace: TraceShape
  leadName: string
  open: boolean
  onClose: () => void
}

export function TracePanel({ trace, leadName, open, onClose }: Props) {
  // Escape closes. Registered only while open so it can't swallow the key
  // for anything else on the page.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const g = trace.guardrail
  const writeUsage = trace.usage?.write
  const toneUsage = trace.usage?.tone
  const totalCost = (writeUsage?.cost_usd ?? 0) + (toneUsage?.cost_usd ?? 0)
  const totalLatency = (writeUsage?.latency_ms ?? 0) + (toneUsage?.latency_ms ?? 0)

  const factsUsed = trace.facts_used ?? []
  const referenced = trace.facts_referenced_by_model ?? []
  // §8: "a model that references a fact outside facts_used is a signal worth
  // seeing in the trace panel even though it isn't (yet) a hard failure."
  const referencedOutsideUsed = referenced.filter((k) => !factsUsed.includes(k))

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-neutral-900/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Decision trace for ${leadName}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Why this draft?</h2>
            <p className="text-xs text-neutral-500">{leadName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
            aria-label="Close trace panel"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* §9's order is fixed: State → Rules → Strategy → Facts used →
              Guardrail → Cost & latency → Prompt versions → raw JSON. */}

          <Section title="State">
            <p className="text-sm font-medium text-neutral-900">{trace.state ?? "—"}</p>
            {trace.state_inputs && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-600">
                <dt>days since inbound</dt>
                <dd className="text-right font-mono">
                  {trace.state_inputs.days_since_inbound ?? "never"}
                </dd>
                <dt>touch count</dt>
                <dd className="text-right font-mono">{trace.state_inputs.touch_count ?? "—"}</dd>
                <dt>opted out</dt>
                <dd className="text-right font-mono">
                  {trace.state_inputs.opted_out ? "yes" : "no"}
                </dd>
              </dl>
            )}
          </Section>

          <Section title="Rules evaluated">
            <ul className="flex flex-col gap-1">
              {(trace.rules_evaluated ?? []).map((r) => {
                // Trap 1 — matched and winner are different states.
                const isWinner = r.name === trace.rule_fired
                return (
                  <li
                    key={r.name}
                    className={cn(
                      "flex items-center gap-2 rounded px-2 py-1 text-sm",
                      isWinner
                        ? "bg-emerald-50 font-medium text-emerald-900"
                        : r.matched
                          ? "bg-neutral-100 text-neutral-800"
                          : "text-neutral-400",
                    )}
                  >
                    <span aria-hidden="true">{isWinner ? "★" : r.matched ? "•" : "·"}</span>
                    <span className="font-mono text-xs">{r.name}</span>
                    {isWinner && (
                      <span className="ml-auto text-xs">
                        won · priority {trace.rule_priority ?? "—"}
                      </span>
                    )}
                    {!isWinner && r.matched && (
                      <span className="ml-auto text-xs text-neutral-500">matched, outranked</span>
                    )}
                  </li>
                )
              })}
            </ul>
            {trace.suppressed_by_cooldown && (
              <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                <span className="font-semibold">{trace.suppressed_by_cooldown}</span> won but was
                inside its own cooldown window, so the lead was suppressed (§6.3).
              </p>
            )}
          </Section>

          <Section title="Strategy">
            <p className="font-mono text-sm text-neutral-900">{trace.strategy ?? "—"}</p>
            {/*
              §9's section list does not name fact_gaps, but `fill_missing_fact`
              is unreadable without it — it IS the input that chose the
              strategy. Shown here as a secondary line rather than as its own
              section, so §9's seven sections stay intact.
            */}
            {trace.fact_gaps && trace.fact_gaps.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-xs text-neutral-500">missing required facts</p>
                <KeyList items={trace.fact_gaps} />
              </div>
            )}
          </Section>

          <Section title="Facts used">
            {/* §12 checkbox: facts_referenced_by_model alongside facts_used. */}
            <p className="mb-1 text-xs text-neutral-500">
              selected by the strategy ({factsUsed.length})
            </p>
            <KeyList items={factsUsed} />

            <p className="mt-3 mb-1 text-xs text-neutral-500">
              actually referenced by the model ({referenced.length})
            </p>
            <KeyList items={referenced} />

            {referencedOutsideUsed.length > 0 && (
              <div className="mt-3 rounded bg-amber-50 px-2 py-2">
                <p className="mb-1 text-xs font-medium text-amber-900">
                  referenced but not in the selected set
                </p>
                <KeyList items={referencedOutsideUsed} tone="amber" />
                <p className="mt-1 text-xs text-amber-800">
                  Not a hard failure — a signal worth seeing (§8).
                </p>
              </div>
            )}
          </Section>

          <Section title="Guardrail">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <dt className="text-neutral-600">deterministic (G1–G5)</dt>
              <dd className="text-right">
                <Verdict value={g?.deterministic} />
              </dd>
              <dt className="text-neutral-600">tone</dt>
              <dd className="text-right">
                <Verdict value={g?.tone} />
              </dd>
            </dl>
            {g?.failed_rule && (
              <p className="mt-2 text-sm text-neutral-900">
                failed on <span className="font-mono">{g.failed_rule}</span>
              </p>
            )}
            {/* Trap 3 — `detail` is deterministic-only, `reasons` tone-only. */}
            {g?.detail && (
              <p className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-900">{g.detail}</p>
            )}
            {g?.reasons && g.reasons.length > 0 && (
              <ul className="mt-1 list-inside list-disc rounded bg-red-50 px-2 py-1 text-xs text-red-900">
                {g.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Cost & latency">
            {/* Trap 2 — tone is absent when the deterministic half failed. */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-500">
                  <th className="text-left font-normal">stage</th>
                  <th className="text-right font-normal">latency</th>
                  <th className="text-right font-normal">cost</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                <tr>
                  <td className="py-0.5 font-sans">write</td>
                  <td className="text-right">{fmtLatency(writeUsage?.latency_ms)}</td>
                  <td className="text-right">{fmtCost(writeUsage?.cost_usd)}</td>
                </tr>
                <tr>
                  <td className="py-0.5 font-sans">tone</td>
                  <td className="text-right">{fmtLatency(toneUsage?.latency_ms)}</td>
                  <td className="text-right">{fmtCost(toneUsage?.cost_usd)}</td>
                </tr>
                <tr className="border-t border-neutral-200 font-semibold">
                  <td className="py-1 font-sans">total</td>
                  <td className="text-right">{fmtLatency(totalLatency)}</td>
                  <td className="text-right">{fmtCost(totalCost)}</td>
                </tr>
              </tbody>
            </table>
            {!toneUsage && (
              <p className="mt-2 text-xs text-neutral-500">
                The tone check never ran — the deterministic guardrail failed first, so nothing was
                spent on it.
              </p>
            )}
          </Section>

          <Section title="Prompt versions">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-neutral-600">write</dt>
              <dd className="text-right font-mono text-xs">
                {trace.prompt_versions?.write ?? "—"}
              </dd>
              <dt className="text-neutral-600">tone</dt>
              <dd className="text-right font-mono text-xs">
                {trace.prompt_versions?.tone ?? "—"}
              </dd>
            </dl>
          </Section>

          {/* §9: "Raw JSON in a collapsed <details> at the bottom." */}
          <Section title="Raw">
            <details>
              <summary className="cursor-pointer text-sm text-neutral-600">
                Raw trace JSON
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-neutral-900 p-3 text-[11px] leading-relaxed text-neutral-100">
                {JSON.stringify(trace, null, 2)}
              </pre>
            </details>
          </Section>
        </div>
      </aside>
    </>
  )
}
```

---

## Step 3 — wire the "Why this?" button in `DraftCard.tsx`

A small, targeted edit — three changes to an existing file.

**1.** Add the import:

```tsx
import { TracePanel } from "@/features/trace/TracePanel"
import type { TraceShape } from "@/features/trace/TracePanel"
```

**2.** Add panel state next to the existing `useState` calls:

```tsx
  const [traceOpen, setTraceOpen] = useState(false)
```

**3.** Replace the disabled button:

```tsx
        {/* §9 lists "Why this?" on the card; TracePanel itself is task 15. */}
        <Button size="sm" variant="ghost" disabled title="Trace panel lands in task 15">
          Why this?
        </Button>
```

with a live one, and render the panel just after it:

```tsx
        <Button size="sm" variant="ghost" onClick={() => setTraceOpen(true)}>
          Why this?
        </Button>
        <TracePanel
          trace={draft.trace as TraceShape}
          leadName={draft.lead.name}
          open={traceOpen}
          onClose={() => setTraceOpen(false)}
        />
```

The cast is the single boundary cast trap 6 calls for — `DraftRow.trace` is
`Record<string, unknown>` and `TraceShape` is all-optional, so nothing is asserted that the data
can contradict.

Panel state lives per-card rather than lifted into `QueuePage`: only one card is ever clicked at a
time, and local state avoids threading a `selectedDraftId` through props for no gain.

### Verify

```bash
pnpm typecheck
pnpm --filter @revive/web build
```

---

## Step 4 — run it against real traces

```bash
supabase start                                   # if not already up
supabase functions serve --env-file .env.local    # terminal 1
pnpm dev                                           # terminal 2
```

If the queue is empty, click **Run cadence tick** to generate drafts. Then click **Why this?** on a
card.

| # | Check | Expect |
|---|---|---|
| 1 | Panel opens from the right, backdrop dims the page | |
| 2 | Escape key, backdrop click, and ✕ all close it | |
| 3 | Section order | State → Rules evaluated → Strategy → Facts used → Guardrail → Cost & latency → Prompt versions → Raw |
| 4 | Rules list | exactly one ★ winner; any other matched rule shows "matched, outranked" in a distinct style; unmatched rules dimmed |
| 5 | Facts used | both lists present, each showing "none" when empty rather than blank |
| 6 | Cost & latency | write, tone and total rows, each a real number |
| 7 | Raw JSON `<details>` | collapsed by default, expands to the full trace |

Cross-check the panel against the database rather than trusting the screen:

```bash
docker exec supabase_db_revive psql -U postgres -tAc \
  "select jsonb_pretty(trace) from drafts order by created_at desc limit 1;"
```

**Trap 1 has real data behind it** — confirm at least one draft whose trace has two matched rules
renders one ★ and one "matched, outranked":

```bash
docker exec supabase_db_revive psql -U postgres -tAc \
  "select id, trace->>'rule_fired',
          (select count(*) from jsonb_array_elements(trace->'rules_evaluated') e
            where (e->>'matched')::bool)
     from drafts;"
```

---

## Step 5 — verify the two failure shapes (traps 2 and 3)

Every trace in the database right now is the happy path, so the guardrail-failure and
missing-tone-usage branches will not appear on their own. Plant them.

**Deterministic (G3) failure — no tone usage, `detail` present:**

```bash
DID=$(docker exec supabase_db_revive psql -U postgres -tAc \
  "select id from drafts where status='pending' limit 1;" | tr -d ' \r\n')

docker exec supabase_db_revive psql -U postgres -c "
update drafts set status = 'needs_review',
  trace = jsonb_set(
            jsonb_set(trace, '{guardrail}',
              '{\"deterministic\":\"fail\",\"tone\":null,\"failed_rule\":\"G3\",\"detail\":\"number 900000 is not in the fact set\"}'::jsonb),
            '{usage}',
            (trace->'usage') - 'tone')
where id = '$DID';"
```

The panel must show: deterministic `fail`, tone **"not reached"**, the `detail` string in red, a
`—` in the tone latency/cost cells, and the explanatory "The tone check never ran…" line. **No
`undefined` anywhere.**

**Tone failure — `reasons` array instead of `detail`:**

```bash
docker exec supabase_db_revive psql -U postgres -c "
update drafts set trace = jsonb_set(trace, '{guardrail}',
  '{\"deterministic\":\"pass\",\"tone\":\"fail\",\"failed_rule\":\"tone\",\"reasons\":[\"too pushy for this agent voice\",\"uses a hard close the agent never uses\"]}'::jsonb)
where id = '$DID';"
```

The panel must render both reasons as list items. Then restore:

```bash
pnpm seed   # drafts are not seeded; re-run a cadence tick afterwards if you want a clean queue
```

---

## Failure signatures

| Symptom | Cause |
|---|---|
| `undefined ms` / `$undefined` in Cost & latency | Trap 2 — unguarded `trace.usage.tone.*` |
| Every matched rule looks like the winner | Trap 1 — using `matched` for the star |
| Guardrail section blank on a `needs_review` draft | Trap 3 — reading only `detail`, or only `reasons` |
| "Facts used" section looks empty/broken | Trap 5 — `[].join()` renders nothing |
| Panel won't close on Escape | listener registered outside the `open` guard, or missing cleanup |
| Panel renders behind the page | z-index — backdrop `z-40`, panel `z-50` |
| `TS6133` / `TS1484` | Trap 7 |

---

## Acceptance and commit

### Checklist

- [ ] **"Why this?"** opens a right-hand slide-over; Escape, backdrop click and ✕ all close it
- [ ] Sections render in §9's exact order, with raw JSON collapsed at the bottom
- [ ] Winner starred, other matched rules highlighted-but-distinct, unmatched dimmed (trap 1)
- [ ] `facts_referenced_by_model` shown alongside `facts_used`, both handling empty (§12 checkbox)
- [ ] A model-referenced key outside `facts_used` is called out (§8)
- [ ] Cost and latency shown per stage plus a total, for every draft (§12 checkbox)
- [ ] A deterministic-failure trace renders with no `undefined` and an explicit "tone not reached"
- [ ] A tone-failure trace renders its `reasons` list
- [ ] Nothing on this panel writes to the database — grep the diff for `update`/`insert`/`rpc`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all green

### Expected tree

```
apps/web/src/features/
├── queue/DraftCard.tsx     # "Why this?" enabled, renders TracePanel
└── trace/
    └── TracePanel.tsx      # new
```

### Commit

```
Task 15: TracePanel slide-over
```

Then update `CLAUDE.md`'s **Current state**. Worth recording: whether any real draft showed a
model-referenced fact outside `facts_used` — §8 predicts it as a signal worth watching, and this is
the first task that can actually observe it.

---

## Next

**Task 16 — the planted regression.** Create `write-v2`, identical to `write-v1` except it deletes
exactly this line from the system prompt:

> `- You may ONLY reference facts present in FACTS below. Do not mention any price, district, date, project name, or unit type that is not there.`

Then verify `WRITE_PROMPT_VERSION=v2 pnpm eval` turns **F19 and/or F20 red on
`no_hallucinated_entities`**, and revert to v1. Both versions stay committed behind the env var so
the demo is a one-line switch, not a live edit.

§10 is emphatic about the timing: *"**Confirm this works before the demo, not during it.**"* This
and task 12 are the two deliverables §11 says can never be skipped.
