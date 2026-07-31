import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { DraftRow, LeadRow } from "@revive/core"
import { supabase } from "@/lib/supabase"
import { fetchDemoAgent } from "@/lib/agent"

/** The lead columns the queue card needs. */
export type QueueLead = Pick<
  LeadRow,
  "id" | "name" | "state" | "source" | "last_inbound_at" | "touch_count"
>

/** A draft joined to its lead via the drafts.lead_id foreign key. */
export interface QueueDraft extends DraftRow {
  lead: QueueLead
}

export function useAgent() {
  return useQuery({ queryKey: ["agent"], queryFn: fetchDemoAgent })
}

/**
 * §9: the queue holds drafts "awaiting approval" — `pending` plus
 * `needs_review`, which is a draft that needs a human decision, not one that
 * has been resolved. Anything already approved/edited/skipped has left the
 * queue.
 */
export function useQueue(agentId: string | undefined) {
  return useQuery({
    queryKey: ["queue", agentId],
    enabled: Boolean(agentId),
    queryFn: async (): Promise<QueueDraft[]> => {
      const { data, error } = await supabase
        .from("drafts")
        .select(
          "*, lead:leads(id, name, state, source, last_inbound_at, touch_count)",
        )
        .eq("agent_id", agentId!)
        .in("status", ["pending", "needs_review"])
        .order("created_at", { ascending: false })

      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as QueueDraft[]
    },
  })
}

/** §8: approve and Edit & Approve are the same call — the body may differ. */
export function useApprove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ draftId, body }: { draftId: string; body: string }) => {
      const { data, error } = await supabase.rpc("approve_draft", {
        p_draft_id: draftId,
        p_body: body,
      })
      if (error) throw error
      // Trap 4 — `returns table` means PostgREST sends a one-element array.
      const row = (data as { message_id: string; provider_msg_id: string }[] | null)?.[0]
      if (!row) throw new Error("approve_draft returned no row")
      return row
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}

/**
 * §8: "Skip stays a plain REST PATCH — it changes no cadence state, so there's
 * nothing to protect with a transaction." Note what is NOT written here:
 * leads.state (§6.1, trap 5) and touch_count (a skipped draft was never sent).
 */
export function useSkip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (draftId: string) => {
      const { error } = await supabase
        .from("drafts")
        .update({ status: "skipped", resolved_at: new Date().toISOString() })
        .eq("id", draftId)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}

/**
 * §9's "Run cadence tick" — generate-drafts for every lead of this agent.
 *
 * No `now` is sent, so §8's override guard is never engaged (that seam exists
 * for the eval harness). Clicking twice is safe: `drafts_one_pending_per_lead`
 * plus the pending-draft skip in generate-drafts make the second run a no-op.
 */
export function useCadenceTick() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await supabase.functions.invoke("generate-drafts", {
        body: { agent_id: agentId },
      })
      if (error) throw error
      return data as {
        run_id: string
        generated: number
        suppressed: number
        needs_review: number
        errors?: number
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  })
}
