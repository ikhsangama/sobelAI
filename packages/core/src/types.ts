/**
 * Shared vocabulary for the whole repo: the schema's enums and row shapes,
 * plus the messaging-provider seam.
 *
 * Row types mirror supabase/migrations/0001_init.sql column-for-column, in
 * snake_case, because they are read straight from PostgREST. `timestamptz`
 * columns are `string` (ISO) — that is what comes over the wire.
 *
 * No logic lives here. classify() is task 4, selectStrategy() task 5,
 * guardrail() task 6.
 */

// ---------------------------------------------------------------------------
// Enums — mirror the four `create type ... as enum` statements in 0001_init.sql,
// same members, same order.
// ---------------------------------------------------------------------------

export type LeadState =
  | 'new'
  | 'warm'
  | 'cold'
  | 'dormant'
  | 'handed_off'
  | 'do_not_contact'

export type QualStatus =
  | 'unqualified'
  | 'partial'
  | 'qualified'
  | 'disqualified'
  | 'handed_off'

export type MsgDirection = 'inbound' | 'outbound'

export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'skipped'
  | 'needs_review'

// ---------------------------------------------------------------------------
// Strategy and rule vocabulary
// ---------------------------------------------------------------------------

/**
 * The seven strategies selectStrategy() can return (task 5).
 *
 * Six of them are message-writing strategies the write prompt understands.
 * `suppress` is the seventh and is deliberately different: when a rule
 * selects it, generate-drafts returns immediately with no draft row and
 * never builds the write prompt — so `suppress` is a valid Strategy but is
 * never a valid *write* strategy. Keeping it in this union is what lets
 * selectStrategy() have a single return type.
 */
export type Strategy =
  | 'soft_check_in'
  | 'new_listing_hook'
  | 'fill_missing_fact'
  | 'instant_qualify'
  | 'market_update'
  | 'final_nudge'
  | 'suppress'

/**
 * The 10 seeded `strategy_rules` rows (§6.3) — this is what
 * `StrategyRuleRow.name` is typed as, deliberately narrower than
 * `RuleName` below. `cooldown_active` and `no_rule_matched` are NOT rows:
 * §6.3 is explicit that a `cooldown_active` *row* was tried in an earlier
 * draft and removed as circular (its own `cooldown_days: 0` made
 * `days_since_outbound < 0`, always false), and §11 task 5 repeats "10
 * rows — `cooldown_active` is a post-selection function, not a row."
 * Reusing the wider `RuleName` union here would let a future seed insert
 * exactly the row the architectural review deleted.
 */
export type SeededRuleName =
  | 'hard_suppress'
  | 'snoozed'
  | 'touch_cap'
  | 'warm_human_handles'
  | 'new_ad_lead'
  | 'last_chance'
  | 'gap_fill'
  | 'listing_hook'
  | 'gentle_check_in'
  | 'long_dormant'

/**
 * Values that can appear as `trace.rule_fired`: the 10 seeded rows above,
 * plus two outcomes the selector reports rather than rows it evaluates —
 * `cooldown_active` when the winning rule is inside its own cooldown
 * window (a post-selection check, §6.3), and `no_rule_matched` when
 * nothing matched at all (§6.3, "If no rule matches"). Both are named
 * explicitly by the contract, so this is // NOTE (§6.3), not a SPEC-GAP.
 */
export type RuleName = SeededRuleName | 'cooldown_active' | 'no_rule_matched'

/**
 * // SPEC-GAP: `leads.source` is a plain `text` column in the schema, not an
 * enum, so the database does not constrain it. This union reproduces the
 * values enumerated in that column's comment. It is a code-side convention,
 * deliberately narrower than the column.
 */
export type LeadSource =
  | 'manual'
  | 'meta_ad'
  | '99co'
  | 'propertyguru'
  | 'referral'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** Shape of the `agents.voice_profile` jsonb column, per its schema default. */
export interface VoiceProfile {
  formality: number
  warmth: number
  brevity: number
  sample_messages: string[]
  sign_off: string
  emoji_ok: boolean
}

export interface AgentRow {
  id: string
  name: string
  voice_profile: VoiceProfile
  /** SGT hour, inclusive. */
  quiet_hours_start: number
  /** SGT hour, exclusive. */
  quiet_hours_end: number
  max_touches: number
  created_at: string
}

export interface LeadRow {
  id: string
  agent_id: string
  name: string
  phone: string
  source: LeadSource
  /** Denormalized cache of classify(). Written only by generate-drafts. */
  state: LeadState
  qualification_status: QualStatus
  last_inbound_at: string | null
  last_outbound_at: string | null
  /** Consecutive outbound with no inbound reply. */
  touch_count: number
  snooze_until: string | null
  opted_out: boolean
  created_at: string
}

export interface MessageRow {
  id: string
  lead_id: string
  agent_id: string
  direction: MsgDirection
  body: string
  sent_at: string
  provider: string
  provider_msg_id: string | null
}

/**
 * A row of `lead_facts`. Append-only: a superseded fact keeps its row and
 * gains a `superseded_at`; fact values are never UPDATEd in place.
 *
 * `value` is `unknown` because the column is jsonb and each key carries a
 * different shape (see FACT_KEYS in facts.ts for what each one holds).
 * Narrow it at the point of use.
 *
 * `evidence` is the verbatim span from the source message that justifies
 * this fact — the anti-hallucination property the repo is built around.
 */
export interface Fact {
  id: string
  lead_id: string
  agent_id: string
  key: string
  value: unknown
  confidence: number
  source_message_id: string | null
  evidence: string
  extracted_at: string
  superseded_at: string | null
}

export interface StrategyRuleRow {
  id: string
  name: SeededRuleName
  /** Higher wins. Unique across rows, so ties are impossible. */
  priority: number
  match: Record<string, unknown>
  strategy: Strategy
  cooldown_days: number
  enabled: boolean
}

export interface DraftRow {
  id: string
  /** Correlates back to the generate-drafts run that produced this draft. */
  run_id: string | null
  lead_id: string
  agent_id: string
  strategy: Strategy
  body: string
  status: DraftStatus
  /**
   * The full decision trace. Typed loosely here on purpose: the trace shape
   * is specified in §8 and lands as a named type at task 11, when
   * generate-drafts actually builds one.
   */
  trace: Record<string, unknown>
  created_at: string
  resolved_at: string | null
}

export interface EvalRunRow {
  id: string
  run_id: string
  fixture_id: string
  passed: boolean
  failures: unknown[]
  latency_ms: number | null
  cost_usd: number | null
  prompt_version: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Messaging provider
// ---------------------------------------------------------------------------

/**
 * // SPEC-GAP: referenced by MessagingProvider.parseWebhook but never defined
 * in the contract. Derived from the `messages` table: what a provider can
 * pull out of a webhook payload before it has been resolved to a lead.
 *
 * No consumer in this build — §8's `ingest-inbound` takes `lead_id`
 * directly and never resolves a phone. A real provider adapter would look
 * up `from` against `leads.phone` before calling `ingest-inbound`; this
 * type documents that seam, not a resolution step that exists today.
 */
export interface InboundMessage {
  from: string
  body: string
  sent_at: string
  provider_msg_id: string
}

// SEAM: Unipile + Meta Cloud API coexist here
export interface MessagingProvider {
  name: 'mock' | 'unipile' | 'meta_cloud'
  send(to: string, body: string): Promise<{ providerMsgId: string }>
  parseWebhook(payload: unknown): InboundMessage[]
}
