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
