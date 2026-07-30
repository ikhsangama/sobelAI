-- Atomically supersede the current live lead_facts row for (lead_id, key), if
-- one exists, and insert the new value. Fixes a review finding on PR #19
-- (task 9, extract-facts): doing this as two separate awaited statements from
-- the edge function meant an UPDATE (supersede) failure *after* a successful
-- INSERT left two live rows for the same key -- the exact defect the
-- insert-before-supersede reorder was trying to avoid, just triggered from
-- the other direction. A single transaction closes both failure directions
-- at once, the same reason approve_draft (amendment A1, ships as
-- 0005_approve_draft.sql) is a plpgsql function rather than several
-- client-side statements.
create or replace function supersede_and_insert_fact(
  p_lead_id uuid,
  p_agent_id uuid,
  p_key text,
  p_value jsonb,
  p_confidence numeric,
  p_source_message_id uuid,
  p_evidence text
) returns table (
  id uuid,
  key text,
  value jsonb,
  confidence numeric,
  source_message_id uuid,
  evidence text,
  did_supersede boolean
)
language plpgsql
as $$
declare
  v_did_supersede boolean;
begin
  update lead_facts
    set superseded_at = now()
    where lead_facts.lead_id = p_lead_id
      and lead_facts.key = p_key
      and lead_facts.superseded_at is null;
  v_did_supersede := found;

  return query
    insert into lead_facts (lead_id, agent_id, key, value, confidence, source_message_id, evidence)
    values (p_lead_id, p_agent_id, p_key, p_value, p_confidence, p_source_message_id, p_evidence)
    returning lead_facts.id, lead_facts.key, lead_facts.value, lead_facts.confidence,
              lead_facts.source_message_id, lead_facts.evidence, v_did_supersede;
end;
$$;

-- Same SPEC-GAP as 0002_rls.sql: objects created by a plain migration (not
-- supabase_admin) have no default privileges. extract-facts calls this via
-- the service-role client; PostgREST's RPC path still checks EXECUTE.
grant execute on function supersede_and_insert_fact(
  uuid, uuid, text, jsonb, numeric, uuid, text
) to service_role;
