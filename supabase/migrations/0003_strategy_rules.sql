-- Task 5 / planning-overview.md §6.3 — the 10 strategy rules.
--
-- Reference data, not demo fixtures: the cadence engine cannot run without
-- these, so they ship as a migration rather than in seed.ts (task 8).
--
-- There are 10 rows. `cooldown_active` is deliberately NOT among them — it is
-- a post-selection check in selectStrategy(), not a rule that competes on
-- priority. An earlier draft had it here at priority 85 matching
-- `days_since_outbound < 0`, which is always false and circular besides.
--
-- `match` is evaluated by selectStrategy() against a closed six-key schema:
-- state_in, source_eq, snoozed, touch_count, fact_gaps_len, days_silent.
-- Keys are ANDed; an unrecognised key throws. Numeric conditions take
-- eq/gt/gte/lt/lte, with either a literal or {"agent":"max_touches"} plus an
-- optional integer "offset" on the right-hand side.
--
-- Priorities must stay unique — selectStrategy() throws on a tie.

insert into strategy_rules (name, priority, strategy, cooldown_days, enabled, match) values
  ('hard_suppress',      100, 'suppress',          0, true,
   '{"state_in":["do_not_contact","handed_off"]}'::jsonb),

  ('snoozed',             95, 'suppress',          0, true,
   '{"snoozed":true}'::jsonb),

  ('touch_cap',           90, 'suppress',          0, true,
   '{"touch_count":{"gte":{"agent":"max_touches"}}}'::jsonb),

  ('warm_human_handles',  80, 'suppress',          0, true,
   '{"state_in":["warm"],"touch_count":{"gt":0}}'::jsonb),

  ('new_ad_lead',         75, 'instant_qualify',   0, true,
   '{"state_in":["new"],"source_eq":"meta_ad"}'::jsonb),

  ('last_chance',         70, 'final_nudge',       7, true,
   '{"state_in":["cold","dormant"],"touch_count":{"eq":{"agent":"max_touches","offset":-1}}}'::jsonb),

  ('gap_fill',            60, 'fill_missing_fact', 5, true,
   '{"state_in":["cold","dormant"],"fact_gaps_len":{"gt":0}}'::jsonb),

  ('listing_hook',        50, 'new_listing_hook',  5, true,
   '{"state_in":["cold"],"days_silent":{"gte":14},"fact_gaps_len":{"eq":0}}'::jsonb),

  ('gentle_check_in',     40, 'soft_check_in',     5, true,
   '{"state_in":["cold"],"touch_count":{"lte":2}}'::jsonb),

  ('long_dormant',        30, 'market_update',    14, true,
   '{"state_in":["dormant"]}'::jsonb);
