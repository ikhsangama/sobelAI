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
