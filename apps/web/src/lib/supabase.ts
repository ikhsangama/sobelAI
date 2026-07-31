import { createClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL
const serviceRoleKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.local.example to .env.local and fill in the values from `supabase status -o json`.",
  )
}

/**
 * The demo client runs on the SERVICE ROLE, deliberately (§3, §12).
 *
 * The RLS policies in 0002_rls.sql read `auth.jwt() ->> 'agent_id'`. The anon
 * key carries no such claim, so every tenant table reads back as an empty
 * array — HTTP 200, no error, nothing to debug. §12's definition of done
 * settles the trade-off: policies ship on day one, the demo runs service-role
 * with a single hardcoded agent, and the README says so plainly.
 *
 * This is safe here only because everything is local. A hosted deployment
 * would mint a real JWT carrying `agent_id` and drop back to the anon key.
 */
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
})
