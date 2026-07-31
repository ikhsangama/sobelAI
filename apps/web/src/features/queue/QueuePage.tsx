import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { DraftCard } from "./DraftCard"
import { useAgent, useApprove, useCadenceTick, useQueue, useSkip } from "./useDrafts"

/** PostgREST surfaces the plpgsql `raise ... using message/detail` as these. */
interface RpcError {
  code?: string
  message?: string
  details?: string
}

function quietHoursMessage(details: string | undefined): string {
  try {
    const d = JSON.parse(details ?? "{}") as {
      quiet_hours_start?: number
      quiet_hours_end?: number
      sgt_hour?: number
    }
    return `Outside quiet hours — it is ${d.sgt_hour}:00 SGT and this agent sends between ${d.quiet_hours_start}:00 and ${d.quiet_hours_end}:00.`
  } catch {
    return "Outside quiet hours."
  }
}

export function QueuePage() {
  const [banner, setBanner] = useState<string | null>(null)
  // Pinned per render pass so every card measures "days silent" against the
  // same instant (contract rule 3's habit, applied to the UI).
  const now = useMemo(() => new Date(), [])

  const agent = useAgent()
  const queue = useQueue(agent.data?.id)
  const approve = useApprove()
  const skip = useSkip()
  const tick = useCadenceTick()

  const busy = approve.isPending || skip.isPending || tick.isPending
  const drafts = queue.data ?? []

  function handleApprove(draftId: string, body: string) {
    setBanner(null)
    approve.mutate(
      { draftId, body },
      {
        onError: (err) => {
          const e = err as RpcError
          if (e.message === "outside_quiet_hours") setBanner(quietHoursMessage(e.details))
          else if (e.message === "draft_already_resolved")
            setBanner("That draft was already resolved — refreshing the queue.")
          else setBanner(e.message ?? "Approve failed.")
        },
      },
    )
  }

  function handleTick() {
    setBanner(null)
    if (!agent.data) return
    tick.mutate(agent.data.id, {
      onSuccess: (r) =>
        setBanner(
          `Cadence tick: ${r.generated} drafted · ${r.suppressed} suppressed · ${r.needs_review} need review${
            r.errors ? ` · ${r.errors} errored` : ""
          }`,
        ),
      onError: (err) => setBanner((err as RpcError).message ?? "Cadence tick failed."),
    })
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-neutral-900">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"} awaiting approval
        </h1>
        <Button className="ml-auto" disabled={busy || !agent.data} onClick={handleTick}>
          {tick.isPending ? "Running…" : "Run cadence tick"}
        </Button>
      </header>

      {banner && (
        <p className="mt-4 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
          {banner}
        </p>
      )}

      {agent.isError && (
        <p className="mt-4 text-sm text-red-700">{(agent.error as Error).message}</p>
      )}
      {queue.isError && (
        <p className="mt-4 text-sm text-red-700">{(queue.error as Error).message}</p>
      )}

      <section className="mt-4 flex flex-col gap-3">
        {queue.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}

        {!queue.isLoading && drafts.length === 0 && (
          <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            Nothing awaiting approval. Run a cadence tick to generate drafts.
          </p>
        )}

        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            now={now}
            busy={busy}
            onApprove={(body) => handleApprove(d.id, body)}
            onSkip={() => skip.mutate(d.id)}
          />
        ))}
      </section>
    </div>
  )
}
