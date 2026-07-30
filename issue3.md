# Task 3 — `packages/core`: types, sg-rules, facts

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 3:

> `packages/core`: `types.ts`, `sg-rules.ts` (§4), `facts.ts` (§5). No logic yet.

**Outcome:** `packages/core` stops being a stub and becomes the shared vocabulary the rest of the repo imports — the enums and row shapes from the schema, the Singapore geography tables, the fact keys, and the messaging-provider seam. **Types and constants only.**

**What is NOT in this task**, so you don't drift into it:

| Thing | Lands at |
|---|---|
| `classify()` | Task 4 |
| `selectStrategy()` | Task 5 |
| `guardrail()` G1–G5 | Task 6 |
| `MockProvider` (the implementation) | Task 7 |
| The `Trace` type (§8) | Task 11 |
| Deleting `SCAFFOLD_OK` / `scaffold.test.ts` | Task 4 |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

Work top to bottom. Every step ends with a **Verify** block. If a Verify fails, fix it before moving on.

---

## Read this before you start

### Five traps

Each of these produces a `packages/core` that *looks* right and is wrong. Read them now, not after.

**Trap 1 — Do NOT delete `SCAFFOLD_OK`.**
`packages/core/src/index.ts` exports `SCAFFOLD_OK`, and `apps/web/src/App.tsx:1` imports it. Deleting it in this task breaks `pnpm --filter @revive/web build`. It looks like leftover scaffolding you should tidy up. Leave it. It dies at task 4, together with `scaffold.test.ts`, once `classify.test.ts` makes both redundant.

**Trap 2 — `sg-rules.ts` contains NO Singapore policy numbers and NO `LAST_VERIFIED` banner.**
Older drafts of this spec opened the file with a `⚠️ VERIFY BEFORE RELYING ON ANY NUMBER IN THIS FILE` block sitting above placeholder ABSD rates, LTV ratios, and MOP durations. **All of that is gone.** The current header says the opposite: no policy threshold is encoded anywhere in this repo, by design. §12 has a checkbox for exactly this. Transcribe the header given in step 2 — not one you remember from somewhere else.

**Trap 3 — `ELIGIBILITY_TOPICS` entries are `{ id, ask }` and nothing else.**
You will see the word `triggerWhen` in that file — **only inside a `// SPEC-GAP:` comment** explaining that a condition-DSL field was deleted on review because nothing consumes it. Keep the comment. Do not resurrect the field. If your `ELIGIBILITY_TOPICS` has a third key, you have re-added something that was deliberately removed.

**Trap 4 — `verbatimModuleSyntax` is on. Type imports need `import type`.**
`packages/core/tsconfig.json` sets `"verbatimModuleSyntax": true`. That means:

```ts
import { Fact } from './types'        // ❌ fails typecheck
import type { Fact } from './types'   // ✅
```

This is the single most likely build break in this task, and the error message (`'Fact' is a type and must be imported using a type-only import...`) is easy to skim past.

**Trap 5 — `MAX_DRAFT_CHARS` is `400`, not `480`.**
An older draft used 480 while the prompts said 400, which meant a 430-character draft could pass the length guardrail and still fail tone check. It is now one number, referenced by name everywhere. `400`.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- All four files in this task live in `$REPO/packages/core/src/`.

---

## Step 1 — `packages/core/src/types.ts`

**This is the only file in this task that isn't a straight transcription, so read this paragraph before typing.** The contract names just five type identifiers anywhere in its 800 lines: `MessagingProvider` and `InboundMessage` (§1), `LeadRow` and `LeadState` (§6.1), and `Fact` (§5). Everything else below is derived directly from the schema in `supabase/migrations/0001_init.sql` — the row types are a mirror of the columns that already exist. Where something genuinely wasn't derivable, it carries a `// SPEC-GAP:` comment, per contract rule 1. Do not add types beyond what's here; do not "improve" the shapes.

Two conventions that apply throughout, decided once so they're consistent:

- **`timestamptz` columns are typed `string`,** not `Date`. That is what PostgREST and `supabase-js` actually return over the wire, and the eval fixtures (task 12) carry ISO strings too. `classify(lead, now: Date)` still takes a real `Date` for `now` — the contract requires the clock be injected — and task 4's `diffDays` helper bridges the two.
- **Field names are snake_case,** matching the Postgres columns exactly. These objects are read straight from the database; renaming to camelCase would mean a mapping layer nothing asks for.

Create the file with exactly this content:

```ts
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
 * Values that can appear as `trace.rule_fired`.
 *
 * // SPEC-GAP: this union is intentionally wider than the strategy_rules
 * table. The first ten are seeded rows (task 5). `cooldown_active` and
 * `no_rule_matched` are NOT rows — they are outcomes the selector reports:
 * `cooldown_active` when the winning rule is inside its own cooldown window
 * (a post-selection check, not a rule that competes on priority), and
 * `no_rule_matched` when nothing matched at all.
 */
export type RuleName =
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
  | 'cooldown_active'
  | 'no_rule_matched'

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
  name: RuleName
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
 * `from` is the sender's phone, which ingest-inbound matches against
 * `leads.phone`.
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
```

### Verify

```bash
cd $REPO
grep -c "^export type\|^export interface" packages/core/src/types.ts
grep -c "SEAM: Unipile" packages/core/src/types.ts
grep -c "SPEC-GAP" packages/core/src/types.ts
```

Expected: `17`, `1`, `3`.

(17 exported types = 7 unions — the four enum mirrors plus `Strategy`, `RuleName`, `LeadSource` — and 10 interfaces. The three `SPEC-GAP`s are `RuleName`, `LeadSource`, and `InboundMessage`: the three places this file goes beyond what the contract states.)

---

## Step 2 — `packages/core/src/sg-rules.ts`

Straight transcription. **Re-read traps 2, 3 and 5 before you start.** Create the file with exactly this content:

```ts
/**
 * DISTRICTS and AREA_ALIASES are geography — they don't change.
 *
 * No Singapore property POLICY threshold (ABSD rate, LTV ratio, MOP duration,
 * EIP quota) is encoded anywhere in this file, or anywhere in this repo, by
 * design. ELIGIBILITY_TOPICS below only decides which clarifying QUESTION the
 * assistant asks (see guardrail G4 — "no advice"); the system never asserts
 * an eligibility fact or a number tied to one.
 */

export const DISTRICTS = {
  D01: { region: 'CCR', areas: ['Raffles Place', 'Marina', 'Cecil'] },
  D02: { region: 'CCR', areas: ['Tanjong Pagar', 'Anson'] },
  D03: { region: 'RCR', areas: ['Queenstown', 'Tiong Bahru', 'Alexandra'] },
  D04: { region: 'RCR', areas: ['Sentosa', 'Harbourfront', 'Telok Blangah'] },
  D05: { region: 'RCR', areas: ['Clementi', 'Pasir Panjang', 'West Coast'] },
  D06: { region: 'CCR', areas: ['High Street', 'Beach Road', 'City Hall'] },
  D07: { region: 'CCR', areas: ['Bugis', 'Rochor', 'Golden Mile'] },
  D08: { region: 'RCR', areas: ['Little India', 'Farrer Park'] },
  D09: { region: 'CCR', areas: ['Orchard', 'River Valley', 'Somerset'] },
  D10: { region: 'CCR', areas: ['Tanglin', 'Holland', 'Bukit Timah'] },
  D11: { region: 'CCR', areas: ['Newton', 'Novena', 'Watten', 'Thomson'] },
  D12: { region: 'RCR', areas: ['Balestier', 'Toa Payoh', 'Serangoon'] },
  D13: { region: 'RCR', areas: ['Macpherson', 'Braddell', 'Potong Pasir'] },
  D14: { region: 'RCR', areas: ['Geylang', 'Eunos', 'Paya Lebar'] },
  D15: { region: 'RCR', areas: ['East Coast', 'Marine Parade', 'Katong', 'Joo Chiat'] },
  D16: { region: 'OCR', areas: ['Bedok', 'Upper East Coast', 'Siglap'] },
  D17: { region: 'OCR', areas: ['Changi', 'Loyang', 'Flora'] },
  D18: { region: 'OCR', areas: ['Tampines', 'Pasir Ris'] },
  D19: { region: 'OCR', areas: ['Hougang', 'Punggol', 'Sengkang', 'Serangoon Gardens'] },
  D20: { region: 'OCR', areas: ['Ang Mo Kio', 'Bishan', 'Thomson'] },
  D21: { region: 'OCR', areas: ['Upper Bukit Timah', 'Clementi Park', 'Ulu Pandan'] },
  D22: { region: 'OCR', areas: ['Jurong', 'Boon Lay', 'Tuas'] },
  D23: { region: 'OCR', areas: ['Bukit Batok', 'Bukit Panjang', 'Choa Chu Kang', 'Dairy Farm'] },
  D24: { region: 'OCR', areas: ['Lim Chu Kang', 'Tengah'] },
  D25: { region: 'OCR', areas: ['Admiralty', 'Woodlands'] },
  D26: { region: 'OCR', areas: ['Mandai', 'Upper Thomson'] },
  D27: { region: 'OCR', areas: ['Sembawang', 'Yishun'] },
  D28: { region: 'OCR', areas: ['Seletar', 'Yio Chu Kang'] },
} as const;

/** Colloquial → district. Lowercased substring match, longest match wins. */
export const AREA_ALIASES: Record<string, keyof typeof DISTRICTS> = {
  'east coast': 'D15', 'katong': 'D15', 'joo chiat': 'D15', 'marine parade': 'D15',
  'bishan': 'D20', 'amk': 'D20', 'ang mo kio': 'D20',
  'cck': 'D23', 'choa chu kang': 'D23', 'bukit batok': 'D23',
  'tpy': 'D12', 'toa payoh': 'D12',
  'orchard': 'D09', 'river valley': 'D09',
  'holland v': 'D10', 'holland village': 'D10', 'bukit timah': 'D10',
  'tampines': 'D18', 'pasir ris': 'D18',
  'punggol': 'D19', 'sengkang': 'D19', 'hougang': 'D19',
  'yishun': 'D27', 'sembawang': 'D27',
  'woodlands': 'D25', 'admiralty': 'D25',
  'jurong': 'D22', 'boon lay': 'D22',
  'clementi': 'D05', 'west coast': 'D05',
  'tiong bahru': 'D03', 'queenstown': 'D03',
  'bedok': 'D16', 'siglap': 'D16',
  'novena': 'D11', 'newton': 'D11', 'thomson': 'D11',
  'tanjong pagar': 'D02',
  'geylang': 'D14', 'paya lebar': 'D14',
};

export type BuyerProfile = 'citizen' | 'pr' | 'foreigner' | 'unknown';

/**
 * The keywords G4 ("no advice") checks for — if a draft mentions any of
 * these, it must phrase the sentence as a question (see G4).
 *
 * `ask` is documentation of *why* each topic exists, not executable logic.
 * // SPEC-GAP: an earlier draft had a `triggerWhen` field meant to gate which
 * question fill_missing_fact should ask. Nothing in §6.3 or §7.2 consumes a
 * condition language, and building a parser for one is scope this repo
 * doesn't need — fill_missing_fact fills gaps from REQUIRED_FOR_QUALIFIED
 * only (§5). Deleted rather than left unevaluated.
 */
export const ELIGIBILITY_TOPICS = [
  { id: 'mop',       ask: 'whether their HDB has met its Minimum Occupation Period' },
  { id: 'absd',      ask: 'whether they have factored in Additional Buyer\'s Stamp Duty' },
  { id: 'eip',       ask: 'whether the block still has quota under the Ethnic Integration Policy' },
  { id: 'ltv',       ask: 'whether their loan-to-value limit is affected by an existing mortgage' },
  { id: 'lease_min', ask: 'their intended lease term (HDB has a minimum tenancy period)' },
] as const;

/** Flat keyword list G4 scans for — the only part of ELIGIBILITY_TOPICS that's executable. */
export const ELIGIBILITY_KEYWORDS = ['MOP', 'ABSD', 'EIP', 'LTV', 'stamp duty'] as const;

/** Deterministic guardrail: reject the draft outright. Case-insensitive. */
export const BANNED_PHRASES = [
  'guaranteed', 'guarantee', 'sure profit', 'no risk', 'risk-free',
  'will definitely appreciate', 'confirm will appreciate', 'confirm can',
  'you qualify', 'you are eligible', 'you will be eligible',
  'best price in the market', 'last unit', 'only one left',
  'must buy now', 'price will go up next week',
  'i can get you approved', 'financing is not a problem',
];

/**
 * The ONE length limit in the repo. §7.2 and §7.3 both reference this
 * constant by name instead of restating a number — three different numbers
 * (480/400/~400) used to appear across sg-rules.ts and the two prompts,
 * which meant a 430-char draft could pass G1 and still fail tone check for
 * a reason the agent couldn't act on. Fixed by having one source of truth.
 */
export const MAX_DRAFT_CHARS = 400;
export const MIN_DRAFT_CHARS = 40;
export const SGT_OFFSET_HOURS = 8;
```

Two transcription hazards worth naming:

- **The escaped apostrophe** in `'whether they have factored in Additional Buyer\'s Stamp Duty'`. Drop the backslash and the string terminates early, producing a cascade of confusing syntax errors further down the file.
- **`DISTRICTS` must be declared before `AREA_ALIASES`**, and must keep its `as const`. `AREA_ALIASES` is typed `Record<string, keyof typeof DISTRICTS>`, which only resolves to the 28 district codes if `DISTRICTS` is a const assertion. Without `as const`, `keyof typeof DISTRICTS` still works but the *values* widen to `string`, and later code that indexes `DISTRICTS[alias].region` loses its type.

### Verify

```bash
cd $REPO
grep -cE "^  D[0-9]{2}:"        packages/core/src/sg-rules.ts   # DISTRICTS
grep -oE "'[^']+': 'D[0-9]{2}'" packages/core/src/sg-rules.ts | wc -l   # AREA_ALIASES
grep -c "{ id: "                packages/core/src/sg-rules.ts   # ELIGIBILITY_TOPICS
grep -c "LAST_VERIFIED"         packages/core/src/sg-rules.ts   # must be 0
grep -c "triggerWhen"           packages/core/src/sg-rules.ts   # must be 1 (comment only)
grep -c "MAX_DRAFT_CHARS = 400" packages/core/src/sg-rules.ts
```

Expected, in order: `28`, `40`, `5`, **`0`**, **`1`**, `1`.

The `0` and the `1` are traps 2 and 3 respectively. `grep -c` returning `0` exits non-zero — that is the passing result for the `LAST_VERIFIED` line.

To count `BANNED_PHRASES` (18) and `ELIGIBILITY_KEYWORDS` (5), which span multiple lines each:

```bash
cd $REPO && node --input-type=module -e "
import { BANNED_PHRASES, ELIGIBILITY_KEYWORDS, DISTRICTS } from './packages/core/src/sg-rules.ts'
console.log('BANNED_PHRASES', BANNED_PHRASES.length)
console.log('ELIGIBILITY_KEYWORDS', ELIGIBILITY_KEYWORDS.length)
console.log('DISTRICTS', Object.keys(DISTRICTS).length)
"
```

Expected: `18`, `5`, `28`. (Node 22 strips TypeScript types natively, so this runs the source directly. If your Node is older and rejects it, skip this check — `pnpm typecheck` in step 5 still covers the file.)

---

## Step 3 — `packages/core/src/facts.ts`

Straight transcription again. Create the file with exactly this content:

```ts
import type { Fact } from './types'

export const FACT_KEYS = [
  'transaction_type',   // 'buy' | 'rent' | 'sell'
  'property_type',      // 'hdb' | 'hdb_resale' | 'condo' | 'ec' | 'landed'
  'budget_min',         // number, SGD
  'budget_max',         // number, SGD
  'districts',          // string[] e.g. ['D15','D16']
  'bedrooms',           // number
  'timeline',           // 'immediate' | '1_3_months' | '3_6_months' | '6_12_months' | 'exploring'
  'buyer_profile',      // 'citizen' | 'pr' | 'foreigner'
  'current_housing',    // 'hdb' | 'condo' | 'renting' | 'with_family'
  'purpose',            // 'own_stay' | 'investment'
  'lease_term',         // string, rentals only
  'move_in_date',       // ISO date, rentals only
  'owns_property',      // boolean
  'has_existing_loan',  // boolean
] as const;

/** A lead is `qualified` only when all four are present. */
export const REQUIRED_FOR_QUALIFIED = [
  'transaction_type', 'budget_max', 'districts', 'timeline',
] as const;

export function factGaps(facts: Fact[]): string[] {
  const present = new Set(facts.filter(f => !f.superseded_at).map(f => f.key));
  return REQUIRED_FOR_QUALIFIED.filter(k => !present.has(k));
}
```

**On "no logic yet":** §11 says this task carries none, and `factGaps` is a function — but its body is specified literally by the contract, so writing it is transcription, not design. The rule is aimed at `classify()`, `selectStrategy()`, and `guardrail()`, which the contract describes in prose and expects you to implement with tests. Type it as given; don't add a test file for it in this task.

Note the `import type` on line 1 — trap 4. `Fact` is a type, and this file would fail `pnpm typecheck` with a plain `import`.

### Verify

```bash
cd $REPO
grep -cE "^  '[a-z_]+',[[:space:]]+//" packages/core/src/facts.ts   # FACT_KEYS
grep -c "^import type"                 packages/core/src/facts.ts
```

Expected: `14` and `1`.

Note the `//` in that first pattern — it is doing real work, not decoration. Every `FACT_KEYS` entry carries a trailing `//` comment describing its value type; `REQUIRED_FOR_QUALIFIED`'s four keys sit on one line with no comment. Without the `//` clause the pattern matches that line too and you get `15`, which looks like an extra fact key and sends you hunting for a fifteenth.

---

## Step 4 — `packages/core/src/index.ts`

Replace the file's contents with:

```ts
export * from './types'
export * from './sg-rules'
export * from './facts'

// Exercised by apps/web/src/App.tsx so the workspace import path
// (source-only @revive/core exports, resolved via Vite's dep prebundler)
// is actually proven at scaffold time instead of only declared.
// Removed at task 4, alongside scaffold.test.ts.
export const SCAFFOLD_OK = true
```

`export *` re-exports types and values together and is safe under `verbatimModuleSyntax`; naming symbols individually would force you to split them into `export` and `export type` lists for no benefit.

**`SCAFFOLD_OK` stays** — trap 1. The only change to that line is the added comment noting when it goes.

### Verify

```bash
cd $REPO
grep -c "export \*"     packages/core/src/index.ts
grep -c "SCAFFOLD_OK"   packages/core/src/index.ts
```

Expected: `3` and `1`.

---

## Step 5 — Typecheck, test, build

The real gates for this task.

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0.

- **`pnpm typecheck`** is the primary gate — this task is almost entirely types, so nothing else exercises them. It also catches trap 4.
- **`pnpm test`** stays green via the existing `scaffold.test.ts`. This task adds no tests; task 4 brings the first real ones.
- **`pnpm --filter @revive/web build`** is the trap 1 check. It fails if `SCAFFOLD_OK` was removed, since `App.tsx` imports it.

Note that the web build is also your **barrel check**: `App.tsx` imports `SCAFFOLD_OK` from `@revive/core`, which resolves through `index.ts`. If your three `export *` lines were malformed, that build is what catches it.

Finally, run the constants and `factGaps` for real:

```bash
cd $REPO && node --input-type=module -e "
import { factGaps, FACT_KEYS, REQUIRED_FOR_QUALIFIED } from './packages/core/src/facts.ts'
import { MAX_DRAFT_CHARS, MIN_DRAFT_CHARS, SGT_OFFSET_HOURS, DISTRICTS, BANNED_PHRASES } from './packages/core/src/sg-rules.ts'
console.log('FACT_KEYS', FACT_KEYS.length, '| REQUIRED', REQUIRED_FOR_QUALIFIED.length)
console.log('MAX/MIN/SGT', MAX_DRAFT_CHARS, MIN_DRAFT_CHARS, SGT_OFFSET_HOURS)
console.log('DISTRICTS', Object.keys(DISTRICTS).length, '| BANNED', BANNED_PHRASES.length)
console.log('factGaps([]) ->', factGaps([]))
"
```

Expected, exactly:

```
FACT_KEYS 14 | REQUIRED 4
MAX/MIN/SGT 400 40 8
DISTRICTS 28 | BANNED 18
factGaps([]) -> [ 'transaction_type', 'budget_max', 'districts', 'timeline' ]
```

That last line is the meaningful one: a lead with no facts at all has all four required facts missing — exactly what `gap_fill` (task 5) keys off.

**Import the two leaf files directly, as above — not `./packages/core/src/index.ts`.** Node's ESM loader strips TypeScript types but does *not* resolve extensionless specifiers, so `index.ts`'s `export * from './types'` fails with `ERR_MODULE_NOT_FOUND`. That is a Node resolution limitation, not a defect in your code — `moduleResolution: "bundler"` is exactly what lets TypeScript, Vite, and Deno accept those specifiers. `facts.ts` works here because its only import is `import type`, which is erased entirely at runtime, and `sg-rules.ts` imports nothing.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `'Fact' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled` | Trap 4 | `import type { Fact } from './types'` |
| `Module '"@revive/core"' has no exported member 'SCAFFOLD_OK'` during the web build | Trap 1 — you deleted it | Restore it in `index.ts`; it's removed at task 4, not now |
| `Cannot find name 'DISTRICTS'` in `sg-rules.ts` | `AREA_ALIASES` declared above `DISTRICTS` | Reorder — `DISTRICTS` first |
| A cascade of syntax errors starting mid-`ELIGIBILITY_TOPICS` | Unescaped apostrophe in `Buyer\'s` | Restore the backslash |
| `Type 'string' is not assignable to type '"D01" | "D02" | ...'` | `as const` dropped from `DISTRICTS` | Restore it |
| `Object is possibly 'undefined'` on `AREA_ALIASES[key]` | `noUncheckedIndexedAccess` is on — **this is correct, not a bug** | Nothing to fix in this task; task 9 handles the `undefined` branch when it does alias lookup |
| `pnpm typecheck` passes but `pnpm test` reports no test files | Expected — this task adds none | Not an error |

---

## Step 6 — Acceptance and commit

### Checklist

- [ ] `types.ts` — 17 exported types, the `// SEAM:` comment present, 3 `SPEC-GAP` notes
- [ ] `sg-rules.ts` — 28 districts, 40 aliases, 18 banned phrases, 5 eligibility topics, 5 keywords
- [ ] `sg-rules.ts` — **zero** `LAST_VERIFIED`, **zero** policy numbers, `triggerWhen` appears once and only in a comment
- [ ] `MAX_DRAFT_CHARS = 400`, `MIN_DRAFT_CHARS = 40`, `SGT_OFFSET_HOURS = 8`
- [ ] `facts.ts` — 14 fact keys, 4 required, `factGaps` present, `import type` used
- [ ] `index.ts` — three `export *` lines, `SCAFFOLD_OK` still exported
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all exit 0
- [ ] `factGaps([])` returns all four required keys
- [ ] No `classify`, `selectStrategy`, `guardrail`, or `MockProvider` anywhere — those are tasks 4, 5, 6, 7
- [ ] No `Trace` type — that's task 11

### Expected tree

Only the paths task 3 owns.

```
$REPO/
└── packages/core/src/
    ├── index.ts          # edited: three re-exports added, SCAFFOLD_OK kept
    ├── types.ts          # new
    ├── sg-rules.ts       # new
    ├── facts.ts          # new
    └── scaffold.test.ts  # untouched — deleted at task 4
```

Nothing under `apps/`, `supabase/`, or `packages/llm|eval` changes.

### Commit

Contract rule 6: commit after each numbered task with the task number in the message.

```bash
cd $REPO
git status
git add -A
git commit -m "Task 3: core types, sg-rules, facts"
```

Then update the **Current state** section of `CLAUDE.md` to say task 3 complete, task 4 next.

---

## Next

Task 4 — `classify.ts` + `classify.test.ts`. The first real logic in the repo: a pure function over timestamps returning a `LeadState`, with boundary tests at exactly 2, 7, and 45 days plus the null-inbound branches and all three short-circuits.

Three things to know before you start it:

- **`classify()` takes `now` as a parameter.** Contract rule 3 — no `Date.now()` inside it, no DB calls, no LLM calls. That is what makes the boundary tests possible and what lets the eval harness (task 12) test time-dependent behaviour without mocking clocks.
- **Task 4 is where `SCAFFOLD_OK` and `scaffold.test.ts` finally go.** Delete both once `classify.test.ts` exists, and update `apps/web/src/App.tsx` so it no longer imports `SCAFFOLD_OK`.
- **`leads.state` is a denormalized cache, not a second source of truth.** `classify()` is the only thing that decides state, and `generate-drafts` is the only writer of the column. Task 4 includes a test asserting nothing else writes it — a note absent from older drafts of the spec.
