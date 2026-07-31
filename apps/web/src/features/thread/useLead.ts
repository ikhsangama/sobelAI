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
