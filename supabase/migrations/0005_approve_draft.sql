-- Task 13 / planning-overview.md §8 — approve_draft.
--
-- CLAUDE.md amendment A1: §8 specifies this as a Postgres function doing four
-- things atomically, step 2 being MockProvider.send(). plpgsql cannot invoke
-- TypeScript, so the mock send happens inline here (minting a provider_msg_id
-- is the whole job -- see packages/core/src/mockProvider.ts, whose send() is
-- deliberately pure). MockProvider remains the TS-side seam used by edge
-- functions and the eval harness.
--
-- Renumbered twice: 0003 went to strategy_rules (task 5), 0004 to
-- supersede_and_insert_fact (task 9 review round).
--
-- Why a function and not a client-side PATCH: a partial failure desyncs
-- touch_count, which feeds touch_cap and last_chance (§6.3). Same reasoning
-- 0004_supersede_fact.sql already applied to extract-facts.
--
-- NOT security definer, deliberately: called with invoker rights, so if a real
-- authenticated user ever calls it the tenant_isolation policies in 0002 still
-- apply. The demo calls it with the service role, which has BYPASSRLS anyway.
--
-- SPEC-GAP: §8 documents the quiet-hours failure as `res 409 { "error":
-- "outside_quiet_hours", "quiet_hours_start": 9, "quiet_hours_end": 20 }`.
-- PostgREST owns the error envelope, so the closest faithful mapping is its
-- `PTxxx` SQLSTATE convention: PT409 becomes HTTP 409 and the payload arrives
-- as {code, message, details, hint}. The reason string lands in `message` and
-- the two hour values in `details` as a JSON string. Verified against a live
-- request, not assumed.
create or replace function approve_draft(p_draft_id uuid, p_body text)
returns table (message_id uuid, provider_msg_id text)
language plpgsql
as $$
declare
  v_draft  drafts%rowtype;
  v_agent  agents%rowtype;
  v_hour   int;
  v_msg_id uuid;
  v_pmid   text;
  v_status draft_status;
begin
  -- FOR UPDATE: two operators approving the same card race otherwise.
  select * into v_draft from drafts where id = p_draft_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'draft_not_found';
  end if;

  -- Only an unresolved draft can be approved. Without this, a double-click
  -- sends the message twice and increments touch_count twice.
  if v_draft.status not in ('pending', 'needs_review') then
    raise sqlstate 'PT409' using message = 'draft_already_resolved',
      detail = json_build_object('status', v_draft.status)::text;
  end if;

  select * into v_agent from agents where id = v_draft.agent_id;

  -- §8 step 1 — quiet hours, checked at SEND time, not draft time (§6.4).
  -- Start inclusive, end exclusive.
  v_hour := extract(hour from (now() at time zone 'Asia/Singapore'))::int;
  if v_hour < v_agent.quiet_hours_start or v_hour >= v_agent.quiet_hours_end then
    raise sqlstate 'PT409' using
      message = 'outside_quiet_hours',
      detail  = json_build_object(
        'quiet_hours_start', v_agent.quiet_hours_start,
        'quiet_hours_end',   v_agent.quiet_hours_end,
        'sgt_hour',          v_hour
      )::text;
  end if;

  -- §8 step 2 — MockProvider.send(), inline (amendment A1).
  v_pmid := 'mock-' || gen_random_uuid()::text;

  -- §8 step 3 — the outbound message.
  insert into messages (lead_id, agent_id, direction, body, provider, provider_msg_id)
  values (v_draft.lead_id, v_draft.agent_id, 'outbound', p_body, 'mock', v_pmid)
  returning id into v_msg_id;

  -- §8 step 4 — cadence state and draft resolution, same transaction.
  v_status := case
                when p_body is distinct from v_draft.body then 'edited'
                else 'approved'
              end;

  update leads
     set touch_count      = touch_count + 1,
         last_outbound_at = now()
   where id = v_draft.lead_id;

  -- SPEC-GAP: §8 names status and resolved_at but not drafts.body. The body is
  -- written back so the stored draft matches the message that actually went
  -- out -- otherwise an `edited` draft records text nobody ever received.
  update drafts
     set status      = v_status,
         body        = p_body,
         resolved_at = now()
   where id = p_draft_id;

  message_id := v_msg_id;
  provider_msg_id := v_pmid;
  return next;
end;
$$;

-- Same SPEC-GAP as 0002_rls.sql and 0004_supersede_fact.sql: objects created by
-- a plain migration (not supabase_admin) have no default privileges, and
-- PostgREST's RPC path checks EXECUTE before anything else.
grant execute on function approve_draft(uuid, text) to service_role;
