import { supabase } from "@/lib/supabase"

/**
 * SPEC-GAP: §3 says the demo uses "a single hardcoded agent_id". Hardcoding
 * the *name* rather than the UUID is the same decision with one fewer
 * footgun: `pnpm seed` deletes and reinserts agents by name (task 8), so a
 * literal UUID goes stale on every re-seed and the queue silently empties.
 *
 * Wei Ling is the seed's primary agent — six leads spanning every classify()
 * state. Terence Koh exists only as the contrasting voice for task 12's
 * two-voice eval fixture.
 */
export const DEMO_AGENT_NAME = "Wei Ling"

export async function fetchDemoAgent() {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, max_touches, quiet_hours_start, quiet_hours_end")
    .eq("name", DEMO_AGENT_NAME)
    .single()

  if (error || !data) {
    throw new Error(
      `Agent "${DEMO_AGENT_NAME}" not found. Run \`pnpm seed\`. (${error?.message ?? "no row"})`,
    )
  }
  return data
}
