# Task 14 — `/leads/:id`: the message thread and `FactsPanel`

> **§11 task 14:** `/leads/:id` thread + `FactsPanel` with visible evidence spans.

The second and last UI route. §9 describes it in one paragraph:

> **`/leads/:id`** — two columns. Left: message thread, inbound left / outbound right, timestamps.
> Right: `FactsPanel` — one row per fact showing `key`, `value`, a confidence dot, and the
> **evidence span quoted with the source timestamp**. Superseded facts collapsed under "history".
> This panel is the anti-hallucination story made visible; make it look good.

That last sentence is the point of the whole task. Everything else in this repo argues that the
system can't invent a fact — §5's evidence rule, the server-side verbatim check, the numeric
cross-check, G3. **This screen is where a human can actually see that.** Every fact row shows the
exact words the lead typed, and when they typed them. A reviewer who doesn't trust the pipeline can
check it here in about four seconds.

**Scope boundary.** One route, read-only. `TracePanel` is task 15 — do not build it. Do not add
editing, deleting, or re-extracting facts from this screen. Do not add a lead-list route (§9 says
two routes; you reach a lead from the queue).

---

## Read this before you start

Everything below was run against the live local database before being written down. Where it says
"verified", a command was executed and its output checked.

### Eight traps

**Trap 1 — fact `value` is jsonb and is NOT constrained to §5's enums. Do not switch on it.**

§5 lists tidy enum comments (`transaction_type // 'buy' | 'rent' | 'sell'`), but those are
TypeScript comments — the column is plain `jsonb` and the prompt sends only bare key names, so the
model returns whatever phrasing the lead used. Verified by running the real `extract-facts` against
the seeded Marcus Tan thread:

```
bedrooms         3                    conf=0.95
budget_max       1500000              conf=0.7
buyer_profile    "couple"             conf=0.9     <-- §5 says 'citizen' | 'pr' | 'foreigner'
districts        ["D15"]              conf=0.9
purpose          "own stay"           conf=0.95    <-- §5 says 'own_stay'
```

Two of five facts came back as free text that matches no §5 enum. This is a known, documented
property of the frozen `extract-v1` prompt (see `CLAUDE.md`, task 12 — F02 hit the same thing). So
`FactsPanel` must render **any** jsonb shape generically: string, number, boolean, array. A lookup
table keyed on `'own_stay'` will silently render blanks on real data.

**Trap 2 — `source_message_id` is nullable, so the embedded message can be `null`.**

`0001_init.sql:63` declares `source_message_id uuid references messages(id) on delete set null`. A
fact whose source message was deleted keeps its `evidence` text but loses the link. The row must
still render (the evidence string is the important part) with the timestamp omitted — not crash on
`fact.source_message.sent_at`.

**Trap 3 — timestamps are stored UTC; display them in SGT or the evidence timestamp lies.**

Every `timestamptz` comes back as UTC ISO (`2026-06-22T01:05:00+00:00`). This is a Singapore
product and §9 asks for "the source timestamp" — rendering `01:05` for a message the lead sent at
`09:05` their time makes the anti-hallucination story read wrong. Format with
`timeZone: 'Asia/Singapore'`. Verified:

```
new Date('2026-06-22T01:05:00+00:00')
  .toLocaleString('en-SG', { timeZone:'Asia/Singapore', dateStyle:'medium', timeStyle:'short' })
→ "22 Jun 2026, 9:05 am"
```

**Trap 4 — superseded facts must be filtered out of the main list, not just sorted down.**

`lead_facts` is append-only: a corrected fact gets a **new row** and the old one gains a
`superseded_at` timestamp (§5, "Never UPDATE a fact value"). The live set is
`superseded_at IS NULL` — the same filter `factGaps()` uses in `packages/core/src/facts.ts`. Real
superseded data exists in the seeded database right now, verified after feeding Marcus Tan a
contradicting message and re-running extraction:

```
budget_max | 1500000 | 0.70 | superseded=t | "budget around 1.5m"
budget_max | 1800000 | 1.00 | superseded=f | "can stretch to 1.8m"
```

If you don't filter, the panel shows a lead with two different budgets and the screen argues
against itself.

**Trap 5 — this route writes nothing. Read-only, all three queries.**

§6.1 reserves `leads.state` for `generate-drafts` and task 4 has a guard test that fails if
anything else writes it. Nothing on this page mutates anything — no `update`, no `insert`, no
`rpc`. If you find yourself reaching for `useMutation`, stop.

**Trap 6 — `useParams` gives `string | undefined`; handle the missing/unknown id.**

React Router 7 types `useParams()` loosely. Firing a query with `undefined` produces a PostgREST
request for `id=eq.undefined`, which returns `[]`, which renders an empty page with no explanation.
Gate the queries on `enabled: Boolean(id)` (the pattern `useQueue` already uses in
`features/queue/useDrafts.ts`) and render an explicit "lead not found" state.

**Trap 7 — the same three web-app tsconfig rules that bit task 13.**

`apps/web/tsconfig.app.json` sets `noUnusedLocals`, `noUnusedParameters`, and
`verbatimModuleSyntax`. An import you sketched and no longer use is a **build failure**, and every
type-only import must say `import type`. (`erasableSyntaxOnly` is also on, but task 13 already made
`packages/core` clean for it — nothing further to do.)

**Trap 8 — Tailwind v4. No config file, no `pnpm dlx shadcn add`.**

Theme tokens are CSS variables in `apps/web/src/index.css`. Use ordinary utility classes. The only
shadcn component in the repo is `Button` and you don't need another — every component below is
written out in full. Running the shadcn CLI reaches the network and rewrites `index.css`.

---

### Conventions

- `@/` is aliased to `apps/web/src/`.
- Data hooks live beside the feature that uses them, one file per route
  (`features/queue/useDrafts.ts` is the precedent).
- Anything genuinely unspecified gets a `// SPEC-GAP:` comment and the simplest option.

---

## Step 1 — `apps/web/src/features/thread/useLead.ts`

All three queries for the route in one file.

> **`// SPEC-GAP:`** §1's file list for `features/thread/` names only `ThreadView.tsx` and
> `FactsPanel.tsx`. This hook file follows the `features/queue/useDrafts.ts` precedent from task 13
> rather than putting `supabase` calls inside components — same reasoning, same shape.

```ts
import { useQuery } from "@tanstack/react-query"
import type { Fact, LeadRow, MessageRow } from "@revive/core"
import { supabase } from "@/lib/supabase"

/** The lead row plus the agent it belongs to. */
export interface LeadWithAgent extends LeadRow {
  agent: { id: string; name: string; max_touches: number } | null
}

/**
 * A fact joined to the message its evidence was quoted from.
 *
 * Trap 2 — `source_message_id` is `on delete set null`, so this embed is
 * nullable even though almost every row has one.
 */
export interface FactWithSource extends Fact {
  source_message: Pick<MessageRow, "id" | "body" | "sent_at" | "direction"> | null
}

export function useLead(leadId: string | undefined) {
  return useQuery({
    queryKey: ["lead", leadId],
    enabled: Boolean(leadId),
    queryFn: async (): Promise<LeadWithAgent> => {
      const { data, error } = await supabase
        .from("leads")
        .select("*, agent:agents(id, name, max_touches)")
        .eq("id", leadId!)
        .single()
      if (error) throw new Error(error.message)
      return data as unknown as LeadWithAgent
    },
  })
}

/** §9: "message thread, inbound left / outbound right, timestamps" — oldest first. */
export function useThread(leadId: string | undefined) {
  return useQuery({
    queryKey: ["thread", leadId],
    enabled: Boolean(leadId),
    queryFn: async (): Promise<MessageRow[]> => {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("lead_id", leadId!)
        .order("sent_at", { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as MessageRow[]
    },
  })
}

/**
 * Every fact for the lead, live and superseded, with its source message.
 *
 * Deliberately does NOT filter `superseded_at` in SQL — §9 wants the
 * superseded ones rendered too, collapsed under "history". FactsPanel splits
 * them (trap 4).
 */
export function useFacts(leadId: string | undefined) {
  return useQuery({
    queryKey: ["facts", leadId],
    enabled: Boolean(leadId),
    queryFn: async (): Promise<FactWithSource[]> => {
      const { data, error } = await supabase
        .from("lead_facts")
        .select("*, source_message:messages(id, body, sent_at, direction)")
        .eq("lead_id", leadId!)
        .order("key", { ascending: true })
        .order("extracted_at", { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as FactWithSource[]
    },
  })
}
```

### Verify

The embed alias resolves through `lead_facts.source_message_id` (the only FK from `lead_facts` to
`messages`, so it is unambiguous). Confirmed against the live database:

```bash
SVC=$(grep VITE_SUPABASE_SERVICE_ROLE_KEY .env.local | cut -d= -f2)
LID=$(docker exec supabase_db_revive psql -U postgres -tAc \
  "select id from leads where name='Marcus Tan' limit 1;" | tr -d ' \r\n')

curl -s -G "http://127.0.0.1:54321/rest/v1/lead_facts" \
  --data-urlencode "select=*, source_message:messages(id, body, sent_at, direction)" \
  --data-urlencode "lead_id=eq.$LID" \
  --data-urlencode "order=key.asc,extracted_at.desc" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
```

Expect each row to carry a nested `"source_message": { ... }` object. `pnpm typecheck` after this
step.

---

## Step 2 — `apps/web/src/features/thread/FactsPanel.tsx`

The right column, and the reason this task exists.

```tsx
import type { FactWithSource } from "./useLead"
import { cn } from "@/lib/utils"

/**
 * SPEC-GAP: the contract never defines confidence bands. Three flat buckets is
 * the simplest thing that makes a dot meaningful; nothing downstream reads
 * these, they are presentation only.
 */
function confidenceTone(c: number): { dot: string; label: string } {
  if (c >= 0.8) return { dot: "bg-emerald-500", label: `high confidence (${c.toFixed(2)})` }
  if (c >= 0.5) return { dot: "bg-amber-500", label: `medium confidence (${c.toFixed(2)})` }
  return { dot: "bg-red-500", label: `low confidence (${c.toFixed(2)})` }
}

function formatSgd(n: number): string {
  if (n >= 1_000_000) return `S$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
  if (n >= 1_000) return `S$${Math.round(n / 1_000)}k`
  return `S$${n}`
}

/**
 * Trap 1 — `value` is jsonb and is NOT constrained to §5's enums (a real
 * extraction returns `"couple"` for buyer_profile and `"own stay"` for
 * purpose). Render whatever shape arrives; never look values up in a table.
 */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "number") {
    return key === "budget_min" || key === "budget_max" ? formatSgd(value) : String(value)
  }
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/** Trap 3 — stored UTC, shown SGT. */
function sgt(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function factLabel(key: string): string {
  return key.replace(/_/g, " ")
}

function FactRow({ fact, muted }: { fact: FactWithSource; muted?: boolean }) {
  const tone = confidenceTone(fact.confidence)
  const sentAt = fact.source_message?.sent_at ?? null

  return (
    <li className={cn("border-t border-neutral-200 px-4 py-3 first:border-t-0", muted && "opacity-60")}>
      <div className="flex items-baseline gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", muted ? "bg-neutral-400" : tone.dot)}
          title={tone.label}
          aria-label={tone.label}
        />
        <span className="text-xs tracking-wide text-neutral-500 uppercase">{factLabel(fact.key)}</span>
        <span className="ml-auto text-sm font-semibold text-neutral-900">
          {formatValue(fact.key, fact.value)}
        </span>
      </div>

      {/*
        §9: "the evidence span quoted with the source timestamp".
        §12's checkbox: "Every fact in the UI shows a verbatim evidence span
        with a timestamp". This blockquote IS the anti-hallucination story —
        it is the lead's own words, verified verbatim server-side before the
        row was allowed to exist (§5).
      */}
      <blockquote className="mt-2 border-l-2 border-neutral-300 pl-3 text-sm text-neutral-700 italic">
        “{fact.evidence}”
      </blockquote>
      <p className="mt-1 pl-3 text-xs text-neutral-500">
        {/* Trap 2 — the source message may have been deleted. */}
        {sentAt ? `lead said this · ${sgt(sentAt)}` : "source message no longer available"}
        {muted && fact.superseded_at ? ` · superseded ${sgt(fact.superseded_at)}` : null}
      </p>
    </li>
  )
}

export function FactsPanel({
  facts,
  isLoading,
}: {
  facts: FactWithSource[]
  isLoading: boolean
}) {
  // Trap 4 — the live set is `superseded_at IS NULL`, the same filter
  // factGaps() uses in packages/core/src/facts.ts.
  const live = facts.filter((f) => !f.superseded_at)
  const superseded = facts.filter((f) => f.superseded_at)

  return (
    <aside className="w-full shrink-0 lg:w-96">
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <header className="border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-neutral-900">
            Facts on file{live.length ? ` (${live.length})` : ""}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Every value below is quoted verbatim from the lead's own messages.
          </p>
        </header>

        {isLoading && <p className="px-4 py-6 text-sm text-neutral-500">Loading facts…</p>}

        {!isLoading && live.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500">
            Nothing extracted yet. Facts appear once this lead replies with something concrete.
          </p>
        )}

        <ul>
          {live.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
        </ul>
      </div>

      {/* §9: "Superseded facts collapsed under history". */}
      {superseded.length > 0 && (
        <details className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            History ({superseded.length} superseded)
          </summary>
          <p className="border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500">
            Facts are append-only — a corrected value never overwrites the old one (§5).
          </p>
          <ul>
            {superseded.map((f) => (
              <FactRow key={f.id} fact={f} muted />
            ))}
          </ul>
        </details>
      )}
    </aside>
  )
}
```

---

## Step 3 — `apps/web/src/features/thread/ThreadView.tsx`

The route element: header, two columns, thread on the left.

```tsx
import { Link, useParams } from "react-router-dom"
import type { LeadState, MessageRow } from "@revive/core"
import { cn } from "@/lib/utils"
import { FactsPanel } from "./FactsPanel"
import { useFacts, useLead, useThread } from "./useLead"

const STATE_STYLES: Record<LeadState, string> = {
  new: "bg-blue-50 text-blue-700 border-blue-200",
  warm: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cold: "bg-neutral-100 text-neutral-700 border-neutral-300",
  dormant: "bg-slate-100 text-slate-600 border-slate-300",
  handed_off: "bg-violet-50 text-violet-700 border-violet-200",
  do_not_contact: "bg-red-50 text-red-700 border-red-200",
}

/** Trap 3 — stored UTC, shown SGT. */
function sgt(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  })
}

/** §9: inbound left, outbound right, timestamps. */
function Bubble({ message }: { message: MessageRow }) {
  const inbound = message.direction === "inbound"
  return (
    <li className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div className={cn("max-w-[80%]", inbound ? "text-left" : "text-right")}>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
            inbound
              ? "rounded-tl-sm bg-white text-neutral-900 ring-1 ring-neutral-200"
              : "rounded-tr-sm bg-emerald-50 text-neutral-900",
          )}
        >
          {message.body}
        </div>
        <p className="mt-1 px-1 text-[11px] text-neutral-400">{sgt(message.sent_at)}</p>
      </div>
    </li>
  )
}

export function ThreadView() {
  const { id } = useParams<{ id: string }>()
  const lead = useLead(id)
  const thread = useThread(id)
  const facts = useFacts(id)

  // Trap 6 — an unknown or missing id must say so, not render an empty page.
  if (!id) {
    return <p className="p-6 text-sm text-red-700">No lead id in the URL.</p>
  }
  if (lead.isError) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-700">
          Lead not found: {(lead.error as Error).message}
        </p>
        <Link to="/queue" className="mt-2 inline-block text-sm text-neutral-600 underline">
          Back to queue
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link to="/queue" className="text-xs text-neutral-500 underline underline-offset-2">
        ← Back to queue
      </Link>

      <header className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-neutral-900">
          {lead.data?.name ?? "…"}
        </h1>
        {lead.data && (
          <>
            <span
              className={cn(
                "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
                STATE_STYLES[lead.data.state],
              )}
            >
              {lead.data.state}
            </span>
            <span className="text-xs text-neutral-500">
              {lead.data.source} · {lead.data.phone} · touch {lead.data.touch_count}
              {lead.data.agent ? ` · ${lead.data.agent.name}` : ""}
            </span>
          </>
        )}
      </header>

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        {/* Left column — the thread. */}
        <section className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          {thread.isLoading && <p className="text-sm text-neutral-500">Loading thread…</p>}
          {thread.isError && (
            <p className="text-sm text-red-700">{(thread.error as Error).message}</p>
          )}
          {!thread.isLoading && (thread.data?.length ?? 0) === 0 && (
            <p className="py-8 text-center text-sm text-neutral-500">
              No messages yet.
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {thread.data?.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
          </ul>
        </section>

        {/* Right column — the anti-hallucination story made visible. */}
        <FactsPanel facts={facts.data ?? []} isLoading={facts.isLoading} />
      </div>
    </div>
  )
}
```

---

## Step 4 — wire the route and a way to reach it

**`apps/web/src/App.tsx`** — add the import and one `<Route>`. Leave the rest of the file alone:

```tsx
import { ThreadView } from "@/features/thread/ThreadView"
```

```tsx
        <Routes>
          <Route path="/" element={<Navigate to="/queue" replace />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/leads/:id" element={<ThreadView />} />
        </Routes>
```

Leave the sidebar's inert **Leads** label as it is. §9 specifies two routes and no lead index, so
there is nothing for it to link to — you reach a lead from its queue card, which is the next edit.

**`apps/web/src/features/queue/DraftCard.tsx`** — make the lead name a link. This is a small
targeted edit, not a rewrite (the file may have other work in progress).

Add to the imports:

```tsx
import { Link } from "react-router-dom"
```

Then replace the `<h2>` in the card header:

```tsx
        <h2 className="text-sm font-semibold text-neutral-900">{draft.lead.name}</h2>
```

with:

```tsx
        <h2 className="text-sm font-semibold">
          <Link
            to={`/leads/${draft.lead.id}`}
            className="text-neutral-900 underline-offset-2 hover:underline"
          >
            {draft.lead.name}
          </Link>
        </h2>
```

`draft.lead.id` is already selected by `useQueue`'s embed — no query change needed.

### Verify

```bash
pnpm typecheck
pnpm --filter @revive/web build
```

---

## Step 5 — run it against real data

The seeded database has no facts until something extracts them, so generate a few first.

```bash
supabase start                                    # if not already running
supabase functions serve --env-file .env.local     # terminal 1
pnpm dev                                            # terminal 2
```

Extract facts for the two seeded leads with substantial threads:

```bash
SVC=$(grep VITE_SUPABASE_SERVICE_ROLE_KEY .env.local | cut -d= -f2)
for NAME in "Marcus Tan" "Priya Nair"; do
  LID=$(docker exec supabase_db_revive psql -U postgres -tAc \
    "select id from leads where name='$NAME' limit 1;" | tr -d ' \r\n')
  curl -s -X POST "http://127.0.0.1:54321/functions/v1/extract-facts" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC" \
    -H "Content-Type: application/json" \
    -d "{\"lead_id\":\"$LID\",\"force\":true}"
  echo
done
```

Each should report `"inserted": N` with a `facts` array. Then open `http://localhost:5173/queue`,
click a lead name, and check the route.

| # | Check | Expect |
|---|---|---|
| 1 | Thread column | inbound bubbles left, outbound right, SGT timestamps under each |
| 2 | Facts panel | one row per live fact: key, value, coloured confidence dot |
| 3 | **Every fact row** | a quoted evidence span **and** a timestamp — §12's checkbox |
| 4 | A `districts` fact | renders `D15`, not `["D15"]` |
| 5 | A `budget_max` fact | renders `S$1.5m`, not `1500000` |
| 6 | A free-text fact (`purpose` / `buyer_profile`) | renders the raw string, no blank |
| 7 | Bad id (`/leads/00000000-0000-0000-0000-000000000000`) | "Lead not found", not an empty shell |
| 8 | Jonathan Lim (no messages) | "No messages yet" + "Nothing extracted yet" |

**To see the History section**, create a superseded fact by contradicting one — this is the exact
sequence used to verify trap 4:

```bash
LID=$(docker exec supabase_db_revive psql -U postgres -tAc \
  "select id from leads where name='Marcus Tan' limit 1;" | tr -d ' \r\n')
AID=$(docker exec supabase_db_revive psql -U postgres -tAc \
  "select agent_id from leads where id='$LID';" | tr -d ' \r\n')
docker exec supabase_db_revive psql -U postgres -c \
  "insert into messages (lead_id, agent_id, direction, body, sent_at, provider)
   values ('$LID','$AID','inbound','actually we can stretch to 1.8m after talking to the bank', now(), 'mock');"
# then re-run extract-facts for that lead (command above)
```

Expect `"superseded": 1` in the response, the panel's live row to read **S$1.8m**, and a
**History (1 superseded)** disclosure holding the old **S$1.5m** row, dimmed, with its own evidence
quote and a "superseded" timestamp.

Confirm against the database that the panel isn't lying:

```bash
docker exec supabase_db_revive psql -U postgres -c \
  "select key, value, confidence, superseded_at is not null as superseded, evidence
     from lead_facts where lead_id = '$LID' order by key, extracted_at;"
```

---

## Step 6 — optional: highlight the evidence span in the thread

Only if everything above is solid. §9 asks for the evidence *quoted* in the panel, which Step 2
already does — this is polish on top, and the first thing to cut.

Clicking a fact row scrolls to its source message and highlights the exact span inside the bubble:
lift `selectedFactId` into `ThreadView`, pass `onSelect` into `FactsPanel`, and in `Bubble` split
the body on the selected fact's `evidence` substring, wrapping the match in
`<mark className="bg-amber-200">`.

Two things to get right: the match is **case-insensitive** (§5 validates with
`toLowerCase().includes(...)`, so the stored evidence casing may differ from the body), and the
needle must be escaped before it reaches a `RegExp` or an evidence span containing `(` or `$` will
throw.

---

## Failure signatures

| Symptom | Cause |
|---|---|
| Facts panel empty on a lead with a full thread | No facts extracted yet — run `extract-facts` (Step 5) |
| `Cannot read properties of null (reading 'sent_at')` | Trap 2 — `source_message` is nullable |
| Timestamps 8 hours early | Trap 3 — missing `timeZone: 'Asia/Singapore'` |
| Two contradicting values shown at once | Trap 4 — not filtering `superseded_at` |
| Fact value renders `["D15"]` or blank | Trap 1 — `formatValue` not handling arrays / free text |
| Empty page, no error, on a real lead url | Trap 6 — query fired with `undefined` id |
| `TS6133: declared but never read` | Trap 7 — `noUnusedLocals` |
| `TS1484: ... must be imported using a type-only import` | Trap 7 — `verbatimModuleSyntax` |
| `PGRST200 could not find a relationship` | Embed alias typo — it is `source_message:messages(...)` |

---

## Acceptance and commit

### Checklist

- [ ] `/leads/:id` renders two columns: thread left, `FactsPanel` right
- [ ] Thread shows inbound left, outbound right, each with an SGT timestamp
- [ ] **Every fact row shows a verbatim evidence span and a timestamp** (§12's checkbox)
- [ ] Confidence dot present and colour-coded per fact
- [ ] Superseded facts are excluded from the live list and collapsed under "History"
- [ ] Array, number, boolean and free-text fact values all render sensibly
- [ ] A `budget_*` fact renders as SGD, not a raw integer
- [ ] Unknown lead id renders an explicit not-found state
- [ ] Lead names in `/queue` link to the route
- [ ] Nothing on this page writes to the database — grep the diff for `update`/`insert`/`rpc`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all green

### Expected tree

```
apps/web/src/
├── App.tsx                          # + one <Route> and one import
└── features/
    ├── queue/DraftCard.tsx          # lead name becomes a <Link>
    └── thread/
        ├── ThreadView.tsx           # new — route element, layout, thread column
        ├── FactsPanel.tsx           # new — the evidence panel
        └── useLead.ts               # new — useLead / useThread / useFacts
```

### Commit

```
Task 14: /leads/:id thread + FactsPanel with evidence spans
```

Then update `CLAUDE.md`'s **Current state** with a Task 14 bullet. Worth recording: whether the
free-text fact values from trap 1 showed up in your run too (they are a property of the frozen
`extract-v1` prompt, not a bug to fix here — prompts stay frozen until task 16).

---

## Next

**Task 15** — `TracePanel`, a slide-over rendering `drafts.trace` as labelled sections in §9's
order: State → Rules evaluated (matched ones highlighted, winner starred) → Strategy → Facts used →
Guardrail → Cost & latency → Prompt versions, with raw JSON in a collapsed `<details>` at the
bottom. The **"Why this?"** button on `DraftCard` is already rendered and disabled, waiting for it.

Note §11's triage rule: task 15 is explicitly **the first thing to cut** if time runs short — task
16 (the planted `write-v2` regression) and task 17 (the README) matter more to the demo.
