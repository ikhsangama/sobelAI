import { useState } from "react"
import { diffDays } from "@revive/core"
import type { LeadState } from "@revive/core"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { QueueDraft } from "./useDrafts"

const STATE_STYLES: Record<LeadState, string> = {
  new: "bg-blue-50 text-blue-700 border-blue-200",
  warm: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cold: "bg-neutral-100 text-neutral-700 border-neutral-300",
  dormant: "bg-slate-100 text-slate-600 border-slate-300",
  handed_off: "bg-violet-50 text-violet-700 border-violet-200",
  do_not_contact: "bg-red-50 text-red-700 border-red-200",
}

/**
 * §9: "the failed guardrail rule stated in plain language (including `tone`)".
 * The rule ids come from §6.4; `tone` is set by generate-drafts when the tone
 * check fails after G1–G5 pass.
 */
const GUARDRAIL_REASONS: Record<string, string> = {
  G1: "Draft length is outside the allowed range.",
  G2: "Draft uses a banned phrase.",
  G3: "Draft mentions a number, price, district or date with no matching extracted fact.",
  G4: "Draft states eligibility or financial advice instead of asking a question.",
  G5: "Draft contains an unfilled placeholder.",
  tone: "Tone check flagged this draft as off-voice.",
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  )
}

interface Props {
  draft: QueueDraft
  now: Date
  busy: boolean
  onApprove: (body: string) => void
  onSkip: () => void
}

export function DraftCard({ draft, now, busy, onApprove, onSkip }: Props) {
  const [body, setBody] = useState(draft.body)
  const [editing, setEditing] = useState(false)

  const needsReview = draft.status === "needs_review"
  const guardrail = draft.trace?.guardrail as
    | { failed_rule?: string | null; detail?: string }
    | undefined
  const failedRule = guardrail?.failed_rule ?? null

  const daysSilent =
    draft.lead.last_inbound_at !== null ? diffDays(now, draft.lead.last_inbound_at) : null

  return (
    <article
      className={cn(
        "rounded-lg border border-neutral-200 bg-white p-4 shadow-xs",
        needsReview && "border-l-4 border-l-amber-400",
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">{draft.lead.name}</h2>
        <Chip className={STATE_STYLES[draft.lead.state]}>{draft.lead.state}</Chip>
        {daysSilent !== null && (
          <span className="text-xs text-neutral-500">{daysSilent}d silent</span>
        )}
        <Chip className="border-neutral-200 bg-neutral-50 text-neutral-600">
          {draft.lead.source}
        </Chip>
        <Chip className="ml-auto border-neutral-300 bg-neutral-100 font-mono text-neutral-700">
          {draft.strategy}
        </Chip>
      </header>

      {needsReview && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">Needs review</span> —{" "}
          {failedRule
            ? (GUARDRAIL_REASONS[failedRule] ?? `Guardrail ${failedRule} failed.`)
            : "A guardrail failed."}
          {guardrail?.detail ? ` (${guardrail.detail})` : null}
        </p>
      )}

      {/* WhatsApp-ish bubble, editable inline on click (§9). */}
      {editing ? (
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => setEditing(false)}
          rows={4}
          className="mt-3 w-full rounded-2xl rounded-tl-sm border border-emerald-300 bg-white p-3 text-sm text-neutral-900 outline-none focus:ring-2 focus:ring-emerald-200"
        />
      ) : (
        <p
          onClick={() => setEditing(true)}
          className="mt-3 cursor-text rounded-2xl rounded-tl-sm bg-emerald-50 p-3 text-sm whitespace-pre-wrap text-neutral-900"
        >
          {body}
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => onApprove(body)}>
          {body === draft.body ? "Approve" : "Edit & Approve"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
        {/* §9 lists "Why this?" on the card; TracePanel itself is task 15. */}
        <Button size="sm" variant="ghost" disabled title="Trace panel lands in task 15">
          Why this?
        </Button>
        {body !== draft.body && (
          <button
            type="button"
            onClick={() => setBody(draft.body)}
            className="text-xs text-neutral-500 underline underline-offset-2"
          >
            revert edit
          </button>
        )}
      </footer>
    </article>
  )
}
