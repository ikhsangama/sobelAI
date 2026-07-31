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
