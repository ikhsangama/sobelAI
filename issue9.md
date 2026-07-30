# Task 9 — `extract-facts` + the four-layer evidence enforcement

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 9:

> `extract-facts` edge function + prompt 7.1 + the four-layer evidence enforcement (verbatim substring, server validation, numeric cross-check, superseding — §5) + superseding. Test on all 6 seeded leads; confirm at least one `evidence_mismatch` and one `value_evidence_mismatch` rejection are both possible by stubbing.

**Outcome:** the first edge function, and the machinery behind the repo's single most important correctness property. §5 calls the evidence rule non-negotiable: every `lead_facts` row must carry a verbatim span from a real message, or it does not get inserted.

**This is the biggest task so far.** It is also the first one that touches three packages at once, because it's where Deno starts importing `packages/core` from source. Steps 1 and 2 are prerequisite repairs, both discovered by running the thing rather than reading it — do them first and in order.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `write.ts` / `toneCheck.ts` prompts | Task 11 |
| `ingest-inbound` (which will call this function) | Task 10 |
| `generate-drafts` orchestration | Task 11 |
| Eval fixtures | Task 12 |
| `0004_approve_draft.sql` | Still outstanding; A1 allows it any time before task 13 |

Everything you need to type is written out in full below.

---

## Read this before you start

### Seven traps

**Trap 1 — Deno rejects extensionless relative imports, including type-only ones.**
`packages/core` was written for `moduleResolution: "bundler"`, which lets `./types` resolve. Deno does not, and neither does the Supabase edge runtime. Verified by running a probe function through the real runtime: it failed on `failed to read file: open packages/core/src/types: no such file or directory`, triggered by `facts.ts`'s `import type { Fact } from './types'`. **Even `import type` specifiers must resolve** — the edge runtime resolves before it strips types, so "it's erased anyway" is not true here. Step 1 fixes every intra-core import, not just the runtime ones.

**Trap 2 — the G3 normalizer cannot see a bedroom count, and §5 asks it to.**
§5 layer 3 says to run the G3 normalizer over the evidence span for `budget_min`, `budget_max`, **and `bedrooms`**. But `extractNumbers` ends with `.filter((n) => n >= 1000)` — step 4 of §6.4, correct for scanning a *draft*. Run it on `"a 3 bedder"` and you get `[]`, so the ±2% check finds nothing to compare and **every legitimate `bedrooms` fact is rejected as `value_evidence_mismatch`**. Measured, not guessed. Step 2 splits the floor out; see amendment **A6** below.

**Trap 3 — the parent directory *is* reachable from an edge function.**
`../../../packages/core/src/facts.ts` works: `supabase functions serve` mounts the project root, not just `supabase/functions/`. Verified end-to-end through the real edge runtime (HTTP 200 importing `facts.ts`, `guardrail.ts` and `call.ts` from source). You do **not** need to copy core into `supabase/functions/_shared/`, and you should not — a second copy of the anti-hallucination code is exactly the thing that drifts.

**Trap 4 — every LLM call goes through `call.ts`. No exceptions, including here.**
Contract rule 4. `call.ts` works unmodified in Deno once `supabase/functions/deno.json` maps the bare `@anthropic-ai/sdk` specifier to `npm:@anthropic-ai/sdk@0.115.0` (verified: cost table, fence-stripping and usage logging all correct under Deno 2.1.4). Do not call the SDK directly from the edge function, and do not hand-roll `fetch` — the trace panel's cost and latency numbers are only trustworthy because there is one entry point.

**Trap 5 — a lead with no messages must return 200 with zeros, not an error.**
Task 8 seeded `Jonathan Lim` (the Meta ad lead) with **zero messages**, deliberately — `classify()` only returns `new` when `last_inbound_at` is null. §11 says to test this function on all six seeded leads, so this case is one of the six. Extraction over an empty thread inserts nothing and must not throw, and must not call the LLM at all (there is nothing to extract and it would cost money to learn that).

**Trap 6 — never `UPDATE` a fact's value. Supersede it.**
§5: *"when a new extraction produces a different value for an existing key, set `superseded_at = now()` on the old row and insert a new one."* `lead_facts` is append-only history — the `/leads/:id` FactsPanel (task 14) renders superseded facts under "history", and F14 (task 12) asserts the behaviour. An `UPDATE` destroys the audit trail the whole feature is built to show.

**Trap 7 — rejections are data, not exceptions.**
A rejected fact is a normal outcome, reported in the response's `rejections` array (§8). One bad fact must not abort the other five. `validateFacts` returns both lists and never throws; the test file pins that.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Local Supabase must be running (`supabase start`), and task 8's seed must have been run (`pnpm seed`).

---

## Step 1 — make `packages/core` Deno-importable

Add a `.ts` extension to **every** relative import inside `packages/core/src/`, including `import type` ones (trap 1). Nine files' worth, but only these lines change:

| File | Change |
|---|---|
| `classify.ts:1` | `from './types'` → `from './types.ts'` |
| `facts.ts:1` | `from './types'` → `from './types.ts'` |
| `mockProvider.ts:1` | `from './types'` → `from './types.ts'` |
| `guardrail.ts:1` | `from './types'` → `from './types.ts'` |
| `guardrail.ts:7` | `from './sg-rules'` → `from './sg-rules.ts'` |
| `selectStrategy.ts:10` | `from './types'` → `from './types.ts'` |
| `selectStrategy.ts:11` | `from './classify'` → `from './classify.ts'` |
| `index.ts:1–7` | all seven `export * from './x'` → `'./x.ts'` |

`types.ts` and `sg-rules.ts` have no relative imports and need no change. Test files are not imported by Deno and can be left alone.

A one-liner that does all of it:

```bash
cd $REPO
for f in classify facts mockProvider guardrail selectStrategy index; do
  sed -i "s|from '\./\([a-zA-Z-]*\)'|from './\1.ts'|g" packages/core/src/$f.ts
done
```

TypeScript then needs permission for those extensions. In **`packages/core/tsconfig.json`**, add one line under `"moduleResolution"`:

```json
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
```

That's legal here because the package already sets `"noEmit": true`.

### Verify

```bash
cd $REPO
grep -c "from './[a-zA-Z-]*\.ts'" packages/core/src/index.ts    # 7
grep -rn "from '\./[a-zA-Z-]*'" packages/core/src/*.ts | grep -v test    # no output
pnpm typecheck && pnpm test && pnpm --filter @revive/web build
```

Expected: `7`, no output from the second grep, and all three gates exit 0 with **128 tests** still passing. The web app consumes the same barrel, so a green `build` is what proves this change is invisible to the bundler.

---

## Step 2 — split the magnitude filter out of the normalizer (amendment A6)

Trap 2. In `packages/core/src/guardrail.ts`, `extractNumbers` currently does the normalising *and* the `>= 1000` filtering in one function. Split them, keeping `extractNumbers` behaviourally identical.

Replace the doc comment and signature of `extractNumbers`:

```ts
/** Every number in the draft worth checking: >= 1000 after normalisation. */
export function extractNumbers(draft: string): number[] {
```

with:

```ts
/**
 * Every number in the text, normalised (suffix multiplication, comma
 * stripping, year whitelist) but NOT yet filtered by magnitude.
 *
 * // SPEC-GAP: split out of `extractNumbers` so §5's evidence cross-check can
 * reuse the one normalizer without inheriting G3's >= 1000 floor. That floor
 * is a draft-scanning concern (step 4 of §6.4) — but §5 layer 3 names
 * `bedrooms` among the keys to cross-check, and a bedroom count can never
 * clear 1000, so sharing the filtered version rejected every legitimate
 * bedrooms fact as `value_evidence_mismatch`. G3's own behaviour is
 * unchanged: `extractNumbers` still applies the filter.
 */
export function normalizeNumbers(draft: string): number[] {
```

and replace its last two lines:

```ts
  // Step 4 — only numbers >= 1000 are worth cross-checking.
  return found.filter((n) => n >= 1000)
}
```

with:

```ts
  return found
}

/** Every number in the draft worth checking: >= 1000 after normalisation. */
export function extractNumbers(draft: string): number[] {
  // Step 4 — only numbers >= 1000 are worth cross-checking.
  return normalizeNumbers(draft).filter((n) => n >= 1000)
}
```

Nothing else in `guardrail.ts` changes. `guardrail()` still calls `extractNumbers`, so G3 is untouched.

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -5
```

Still **128 tests**, all green — `guardrail.test.ts`'s 47 are the ones that matter here. If any G3 test goes red you've changed behaviour rather than just relocating it.

---

## Step 3 — `packages/core/src/evidence.ts`

Layers 2 and 3 of §5, as a pure function. Create the file with exactly this content:

```ts
import type { Fact } from './types.ts'
import { FACT_KEYS } from './facts.ts'
import { normalizeNumbers } from './guardrail.ts'

/**
 * Layers 2 and 3 of §5's evidence rule, as a pure function.
 *
 * // SPEC-GAP: §1's file list for packages/core doesn't name this file. It
 * lives here rather than inside the edge function because §5 calls the
 * evidence rule "the single most important correctness property in the repo"
 * and contract rule 3 wants that kind of logic unit-tested without a network
 * or a database. `extract-facts` orchestrates; this decides.
 *
 * Layer 1 is the prompt (§7.1). Layer 4 is the test file next to this one.
 * Superseding is a database concern and stays in the edge function.
 */

export type RejectionReason =
  | 'unknown_key'
  | 'bad_shape'
  | 'bad_message_index'
  | 'evidence_mismatch'
  | 'value_evidence_mismatch'

export interface RawFact {
  key: string
  value: unknown
  confidence: number
  source_message_index: number
  evidence: string
}

export interface AcceptedFact {
  key: Fact['key']
  value: unknown
  confidence: number
  source_message_index: number
  evidence: string
}

export interface Rejection {
  key: string
  reason: RejectionReason
  evidence: string
}

export interface ValidationResult {
  accepted: AcceptedFact[]
  rejections: Rejection[]
}

/**
 * §5 layer 3 applies to these three keys only — the ones whose value is a
 * bare number the model could misread out of a real span.
 */
export const NUMERIC_CROSS_CHECK_KEYS = ['budget_min', 'budget_max', 'bedrooms'] as const

/** §5: "within ±2% of the emitted value", to allow "1.2m" ↔ 1200000. */
const TOLERANCE = 0.02

function isRawFact(x: unknown): x is RawFact {
  if (typeof x !== 'object' || x === null) return false
  const f = x as Record<string, unknown>
  return (
    typeof f.key === 'string' &&
    'value' in f &&
    typeof f.confidence === 'number' &&
    Number.isFinite(f.confidence) &&
    f.confidence >= 0 &&
    f.confidence <= 1 &&
    typeof f.source_message_index === 'number' &&
    Number.isInteger(f.source_message_index) &&
    typeof f.evidence === 'string' &&
    f.evidence.trim().length > 0
  )
}

/**
 * Run the model's raw output through layers 2 and 3.
 *
 * `messages` must be the same array, in the same order, that was numbered
 * into the prompt — `source_message_index` indexes into it.
 */
export function validateFacts(raw: unknown, messages: { body: string }[]): ValidationResult {
  const accepted: AcceptedFact[] = []
  const rejections: Rejection[] = []

  const list = Array.isArray(raw) ? raw : []

  for (const item of list) {
    if (!isRawFact(item)) {
      const key =
        typeof (item as { key?: unknown })?.key === 'string' ? (item as RawFact).key : '(unparseable)'
      const evidence =
        typeof (item as { evidence?: unknown })?.evidence === 'string' ? (item as RawFact).evidence : ''
      rejections.push({ key, reason: 'bad_shape', evidence })
      continue
    }

    if (!(FACT_KEYS as readonly string[]).includes(item.key)) {
      rejections.push({ key: item.key, reason: 'unknown_key', evidence: item.evidence })
      continue
    }

    const message = messages[item.source_message_index]
    if (!message) {
      rejections.push({ key: item.key, reason: 'bad_message_index', evidence: item.evidence })
      continue
    }

    // Layer 2 — verbatim substring of the cited message.
    if (!message.body.toLowerCase().includes(item.evidence.toLowerCase())) {
      rejections.push({ key: item.key, reason: 'evidence_mismatch', evidence: item.evidence })
      continue
    }

    // Layer 3 — the number in the span must be the number that was emitted.
    if ((NUMERIC_CROSS_CHECK_KEYS as readonly string[]).includes(item.key)) {
      const value = item.value
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        rejections.push({ key: item.key, reason: 'value_evidence_mismatch', evidence: item.evidence })
        continue
      }
      const found = normalizeNumbers(item.evidence)
      const withinTolerance = found.some((n) => Math.abs(n - value) <= Math.abs(value) * TOLERANCE)
      if (!withinTolerance) {
        rejections.push({ key: item.key, reason: 'value_evidence_mismatch', evidence: item.evidence })
        continue
      }
    }

    accepted.push({
      key: item.key as Fact['key'],
      value: item.value,
      confidence: item.confidence,
      source_message_index: item.source_message_index,
      evidence: item.evidence,
    })
  }

  return { accepted, rejections }
}
```

Add it to the barrel, `packages/core/src/index.ts` (note the `.ts`, per step 1):

```ts
export * from './evidence.ts'
```

---

## Step 4 — `packages/core/src/evidence.test.ts`

This is §5 layer 4. Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import { validateFacts } from './evidence'

const MESSAGES = [
  { body: 'hi saw ur listing on pg, still available ah' },
  { body: 'looking at katong area, budget around 1.5m for a 3 bedder' },
  { body: 'i stay in tampines, looking to buy in the east' },
]

function fact(over: Partial<Record<string, unknown>> = {}) {
  return {
    key: 'budget_max',
    value: 1500000,
    confidence: 0.9,
    source_message_index: 1,
    evidence: 'budget around 1.5m',
    ...over,
  }
}

describe('validateFacts — layer 2 (verbatim substring)', () => {
  it('accepts a fact whose evidence is a verbatim span of the cited message', () => {
    const r = validateFacts([fact()], MESSAGES)
    expect(r.rejections).toEqual([])
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.key).toBe('budget_max')
  })

  it('is case-insensitive, per §5 ("includes(evidence.toLowerCase())")', () => {
    const r = validateFacts([fact({ evidence: 'BUDGET AROUND 1.5M' })], MESSAGES)
    expect(r.accepted).toHaveLength(1)
  })

  it('rejects fabricated evidence with evidence_mismatch — §5 layer 4', () => {
    const r = validateFacts([fact({ evidence: 'my budget is 1.5 million dollars' })], MESSAGES)
    expect(r.accepted).toEqual([])
    expect(r.rejections).toEqual([
      { key: 'budget_max', reason: 'evidence_mismatch', evidence: 'my budget is 1.5 million dollars' },
    ])
  })

  it('rejects a span that is verbatim in a DIFFERENT message than the one cited', () => {
    // The text exists in messages[1], but the model pointed at messages[0].
    const r = validateFacts([fact({ source_message_index: 0 })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('evidence_mismatch')
  })

  it('rejects an out-of-range source_message_index instead of throwing', () => {
    const r = validateFacts([fact({ source_message_index: 99 })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('bad_message_index')
  })
})

describe('validateFacts — layer 3 (numeric cross-check)', () => {
  it('rejects verbatim evidence whose number contradicts the value — §5 layer 4', () => {
    // §5's own example: evidence "around 1.5m", value 3000000.
    const r = validateFacts([fact({ value: 3000000, evidence: 'budget around 1.5m' })], MESSAGES)
    expect(r.accepted).toEqual([])
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('allows ±2% so "1.2m" matches 1200000', () => {
    const msgs = [{ body: 'buying. budget max 1.2m, looking at D19 only' }]
    const r = validateFacts(
      [fact({ value: 1200000, evidence: 'budget max 1.2m', source_message_index: 0 })],
      msgs,
    )
    expect(r.accepted).toHaveLength(1)
  })

  it('accepts a bedrooms fact — the ≥1000 floor must not apply here', () => {
    // Regression guard for trap 2 / amendment A6: `extractNumbers` filters to
    // >= 1000 for G3, which finds no number in "a 3 bedder" and would reject
    // every legitimate bedrooms fact. validateFacts uses normalizeNumbers.
    const r = validateFacts([fact({ key: 'bedrooms', value: 3, evidence: 'a 3 bedder' })], MESSAGES)
    expect(r.rejections).toEqual([])
    expect(r.accepted[0]!.value).toBe(3)
  })

  it('still rejects a bedrooms fact whose number is wrong', () => {
    const r = validateFacts([fact({ key: 'bedrooms', value: 5, evidence: 'a 3 bedder' })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('rejects a numeric key whose value is not a number', () => {
    const r = validateFacts(
      [fact({ key: 'budget_max', value: '1.5m', evidence: 'budget around 1.5m' })],
      MESSAGES,
    )
    expect(r.rejections[0]!.reason).toBe('value_evidence_mismatch')
  })

  it('does not numeric-cross-check non-numeric keys', () => {
    // "looking at katong area" contains no digits at all; districts is not in
    // NUMERIC_CROSS_CHECK_KEYS, so layer 3 must not touch it.
    const r = validateFacts(
      [fact({ key: 'districts', value: ['D15'], evidence: 'looking at katong area' })],
      MESSAGES,
    )
    expect(r.accepted).toHaveLength(1)
  })
})

describe('validateFacts — shape and key guards', () => {
  it('rejects a key outside FACT_KEYS', () => {
    const r = validateFacts([fact({ key: 'favourite_colour' })], MESSAGES)
    expect(r.rejections[0]!.reason).toBe('unknown_key')
  })

  it('rejects empty or whitespace-only evidence rather than accepting it', () => {
    expect(validateFacts([fact({ evidence: '' })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
    expect(validateFacts([fact({ evidence: '   ' })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
  })

  it('rejects confidence outside 0..1', () => {
    expect(validateFacts([fact({ confidence: 1.5 })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
    expect(validateFacts([fact({ confidence: -0.1 })], MESSAGES).rejections[0]!.reason).toBe('bad_shape')
  })

  it('returns empty results for a non-array payload instead of throwing', () => {
    expect(validateFacts(null, MESSAGES)).toEqual({ accepted: [], rejections: [] })
    expect(validateFacts({ facts: [] }, MESSAGES)).toEqual({ accepted: [], rejections: [] })
  })

  it('keeps going after a rejection — one bad fact does not drop the good ones', () => {
    const r = validateFacts(
      [
        fact({ evidence: 'totally fabricated' }),
        fact({ key: 'bedrooms', value: 3, evidence: 'a 3 bedder' }),
      ],
      MESSAGES,
    )
    expect(r.accepted).toHaveLength(1)
    expect(r.rejections).toHaveLength(1)
  })
})
```

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -5
```

**144 tests** (128 + 16), all green. The two tests §11 explicitly asks for — a fabricated-evidence rejection and a verbatim-but-wrong-value rejection — are `rejects fabricated evidence with evidence_mismatch` and `rejects verbatim evidence whose number contradicts the value`.

---

## Step 5 — `packages/llm/src/prompts/extract.ts`

§7's convention: every prompt exports `{ version, system, buildUser }`. Create the file with exactly this content — the system text is §7.1 verbatim, with the two placeholders filled from `packages/core` so they cannot drift from the real constants:

```ts
import { AREA_ALIASES, FACT_KEYS } from '@revive/core'

/** Bump on every edit — written to `eval_runs.prompt_version` (§10). */
export const version = 'extract-v1'

export const system = `You extract structured facts from WhatsApp conversations between a Singapore
property agent and a lead. You are a transcriber, not an analyst.

Rules:
- Output ONLY a JSON object. No prose, no markdown fences.
- Shape: {"facts":[{"key":..,"value":..,"confidence":0-1,
           "source_message_index":<int>,"evidence":"<verbatim substring>"}]}
- \`evidence\` MUST be an exact substring copied character-for-character from the
  message at \`source_message_index\`. Never paraphrase it. Never reconstruct it.
- If you cannot point to a verbatim span, OMIT the fact entirely. An omitted
  fact is always better than an inferred one.
- Do not infer. "I stay in Tampines" describes where the lead currently
  lives, not a district they want to buy in — do not emit a \`districts\` fact
  from it. "Maybe around 1m" is budget_max=1000000 with confidence 0.6, not
  1.0.
- Only these keys: ${FACT_KEYS.join(', ')}
- Budgets: convert to plain SGD integers. "1.2m"=1200000, "800k"=800000.
  "under 1m" => budget_max only. "1 to 1.2m" => budget_min and budget_max.
- Districts: return the DXX code. Map colloquial names using: ${JSON.stringify(AREA_ALIASES)}
  If a location is ambiguous, omit it.
- The conversation may be in Singlish or mixed English/Chinese. Handle both.
- If the lead contradicts an earlier statement, extract only the MOST RECENT value.`

export interface PromptMessage {
  direction: 'inbound' | 'outbound'
  body: string
}

/**
 * §7.1's user block: "Messages (index: direction: body):" then the numbered
 * list. The index is what the model puts in `source_message_index`, so it
 * must match the array position in the same list `validateFacts` is given.
 */
export function buildUser(messages: PromptMessage[]): string {
  const lines = messages.map((m, i) => `${i}: ${m.direction}: ${m.body}`)
  return `Messages (index: direction: body):\n${lines.join('\n')}`
}
```

Wire up the barrel in `packages/llm/src/index.ts`:

```ts
export * from './call'
export * as extractPrompt from './prompts/extract'
```

> **Why a namespace export.** `version`, `system` and `buildUser` are names task 11's `write.ts` and `toneCheck.ts` will also want. A flat `export *` would collide on all three the moment the second prompt lands.

**// SPEC-GAP: §7.1 says "last 20" messages but doesn't say which end.** The last 20 *chronologically* — the most recent — with the oldest of those at index 0. Step 6 slices accordingly.

---

## Step 6 — `supabase/functions/deno.json`

`call.ts` imports `@anthropic-ai/sdk` by bare specifier (trap 4), and `extract.ts` imports `@revive/core`. Deno resolves neither without a map:

```json
{
  "imports": {
    "@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@0.115.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.111.0",
    "@revive/core": "../../packages/core/src/index.ts"
  }
}
```

All three are verified to resolve under Deno — `deno check` on the finished edge function passes with exactly this map.

Two notes:

- **Keep the npm versions pinned and identical** to the ones in `packages/llm/package.json` and the root `package.json`. Two different SDK versions in two runtimes is a debugging trap with no upside.
- **The `@revive/core` path is relative to this file**, i.e. `supabase/functions/` → `$REPO/packages/core/src/index.ts`. Mapping it here is what lets `extract.ts` keep the ordinary workspace import that `pnpm typecheck` and vitest need — without the map entry, Deno fails with `Relative import path "@revive/core" not prefixed with / or ./ or ../ and not in import map`. Note this pulls the whole barrel, so every file it re-exports must be Deno-clean — which is exactly what step 1 guarantees.

---

## Step 7 — `supabase/functions/extract-facts/index.ts`

The orchestrator. Create the file with exactly this content:

```ts
import { createClient } from '@supabase/supabase-js'
import { validateFacts } from '../../../packages/core/src/evidence.ts'
import { call } from '../../../packages/llm/src/call.ts'
import { buildUser, system, version } from '../../../packages/llm/src/prompts/extract.ts'

/**
 * POST /functions/v1/extract-facts  (§8)
 *   req: { "lead_id": "uuid", "force": false }
 *   res: { lead_id, inserted, superseded, rejected, rejections[], facts[], usage{} }
 *
 * The four-layer evidence rule (§5): layer 1 is the prompt, layers 2 and 3 are
 * `validateFacts` in packages/core, layer 4 is evidence.test.ts. This file adds
 * the database half — superseding — and never inserts a fact the validator
 * didn't accept.
 */

const MODEL = 'claude-sonnet-4-6'
const TEMPERATURE = 0.3 // §2, for the extract stage
const MAX_TOKENS = 4096
const MESSAGE_WINDOW = 20 // §7.1: "last 20"

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? 'http://kong:8000',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Deep-equal for jsonb fact values — arrays and scalars only, no cycles. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

Deno.serve(async (req) => {
  let lead_id: string
  let force = false
  try {
    const body = await req.json()
    lead_id = body.lead_id
    force = body.force === true
    if (typeof lead_id !== 'string' || !lead_id) throw new Error('lead_id is required')
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400)
  }

  const { data: lead, error: leadErr } = await db
    .from('leads')
    .select('id, agent_id')
    .eq('id', lead_id)
    .single()
  if (leadErr || !lead) return json({ error: `lead not found: ${lead_id}` }, 404)

  // §7.1's window is the most recent 20, oldest-first so index 0 is stable.
  const { data: recent, error: msgErr } = await db
    .from('messages')
    .select('id, direction, body, sent_at')
    .eq('lead_id', lead_id)
    .order('sent_at', { ascending: false })
    .limit(MESSAGE_WINDOW)
  if (msgErr) return json({ error: `loading messages failed: ${msgErr.message}` }, 500)

  const messages = (recent ?? []).slice().reverse()

  // Trap 5 — an empty thread is a real state (the seeded Meta ad lead), not an
  // error, and it must not cost an LLM call to discover.
  if (messages.length === 0) {
    return json({
      lead_id,
      inserted: 0,
      superseded: 0,
      rejected: 0,
      rejections: [],
      facts: [],
      usage: { latency_ms: 0, cost_usd: 0, prompt_version: version },
    })
  }

  const { data: existing, error: existErr } = await db
    .from('lead_facts')
    .select('id, key, value')
    .eq('lead_id', lead_id)
    .is('superseded_at', null)
  if (existErr) return json({ error: `loading facts failed: ${existErr.message}` }, 500)

  // SPEC-GAP: §8 documents `force` but not what it forces. Cheapest useful
  // reading: without it, skip the LLM call when nothing has arrived since the
  // last extraction. Re-running `pnpm eval` or a cadence tick then costs $0
  // instead of re-paying for an identical answer.
  if (!force && (existing?.length ?? 0) > 0) {
    const { data: lastRun } = await db
      .from('lead_facts')
      .select('extracted_at')
      .eq('lead_id', lead_id)
      .order('extracted_at', { ascending: false })
      .limit(1)
    const lastExtractedAt = lastRun?.[0]?.extracted_at
    const newestMessageAt = messages[messages.length - 1]!.sent_at
    if (lastExtractedAt && newestMessageAt <= lastExtractedAt) {
      return json({
        lead_id,
        inserted: 0,
        superseded: 0,
        rejected: 0,
        rejections: [],
        facts: existing ?? [],
        usage: { latency_ms: 0, cost_usd: 0, prompt_version: version },
      })
    }
  }

  let parsed: { facts?: unknown }
  let usage
  try {
    const result = await call<{ facts?: unknown }>({
      stage: 'extract',
      model: MODEL,
      prompt_version: version,
      system,
      user: buildUser(messages),
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    })
    parsed = result.parsed
    usage = result.usage
  } catch (err) {
    return json({ error: `extraction failed: ${(err as Error).message}` }, 502)
  }

  // Layers 2 and 3. `messages` here is the exact array numbered into the
  // prompt, so source_message_index lines up.
  const { accepted, rejections } = validateFacts(parsed.facts, messages)

  let inserted = 0
  let superseded = 0

  for (const f of accepted) {
    const prior = (existing ?? []).find((e) => e.key === f.key)

    // Unchanged value — nothing to record. Inserting a duplicate would grow
    // the history with rows that say nothing happened.
    if (prior && sameValue(prior.value, f.value)) continue

    // Trap 6 — supersede, never UPDATE.
    if (prior) {
      const { error } = await db
        .from('lead_facts')
        .update({ superseded_at: new Date().toISOString() })
        .eq('id', prior.id)
      if (error) return json({ error: `superseding ${f.key} failed: ${error.message}` }, 500)
      superseded++
    }

    const { error } = await db.from('lead_facts').insert({
      lead_id,
      agent_id: lead.agent_id,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      source_message_id: messages[f.source_message_index]!.id,
      evidence: f.evidence,
    })
    if (error) return json({ error: `inserting ${f.key} failed: ${error.message}` }, 500)
    inserted++
  }

  const { data: live } = await db
    .from('lead_facts')
    .select('key, value, confidence, evidence, source_message_id')
    .eq('lead_id', lead_id)
    .is('superseded_at', null)

  return json({
    lead_id,
    inserted,
    superseded,
    rejected: rejections.length,
    rejections,
    facts: live ?? [],
    usage: {
      latency_ms: usage.latency_ms,
      cost_usd: usage.cost_usd,
      prompt_version: usage.prompt_version,
    },
  })
})
```

Two things worth noticing:

- **`superseded_at` is only ever set, never a value overwritten.** The `update` call touches exactly one column, on the old row, and the new value always arrives as a fresh `insert`. That's the letter of trap 6.
- **`source_message_id` comes from the array, not the model.** The model supplies an *index*; the function resolves it against the same list it was shown. A model that invents an index gets `bad_message_index` from the validator and never reaches this line.

---

## Step 8 — run it

The function needs an API key. `supabase functions serve` reads `--env-file`:

```bash
cd $REPO
supabase start                      # if not already running
pnpm seed                           # task 8's data
supabase functions serve --no-verify-jwt --env-file .env.local
```

Leave that running. In a second terminal, get a lead id and call it:

```bash
cd $REPO
MARCUS=$(docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id from leads where name='Marcus Tan' limit 1;")
curl -s -X POST http://127.0.0.1:54321/functions/v1/extract-facts \
  -H 'Content-Type: application/json' \
  -d "{\"lead_id\":\"$MARCUS\"}" | head -60
```

Expect `inserted` > 0 and a `facts` array containing `budget_max: 1500000`, `districts: ["D15"]`, `bedrooms: 3`, `transaction_type: "buy"` — and **no `timeline`**, because Marcus's thread never states one. That absence is the whole point of the seeded `cold_with_gap` lead: it's what makes `gap_fill` win over `listing_hook` at task 11.

### Verify — all six seeded leads (§11)

```bash
cd $REPO
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select id||' '||name from leads where agent_id=(select id from agents where name='Wei Ling') order by created_at;" |
while read id name; do
  echo "--- $name ---"
  curl -s -X POST http://127.0.0.1:54321/functions/v1/extract-facts \
    -H 'Content-Type: application/json' -d "{\"lead_id\":\"$id\"}" |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
      console.log(' inserted',j.inserted,'superseded',j.superseded,'rejected',j.rejected,
      '| keys:',(j.facts||[]).map(f=>f.key).sort().join(','))})"
done
```

What each lead should show:

| Lead | Expect |
|---|---|
| Rachel Goh (dormant) | a couple of facts; no crash |
| Priya Nair (cold, complete) | all four of `transaction_type`, `budget_max`, `districts`, `timeline` |
| Marcus Tan (cold, gap) | `budget_max`, `districts`, `bedrooms`, `transaction_type` — **no `timeline`** |
| Kelvin Ong (opted out) | few or no facts; must not error |
| Siti Rahman (warm) | rental facts; `transaction_type: "rent"` |
| **Jonathan Lim (meta ad)** | **`inserted 0`, `rejected 0`, `keys:` empty — and zero cost** (trap 5) |

Then confirm the anti-inference trap from F18 holds. Priya's and Marcus's threads both mention areas; Siti's says *"tampines or pasir ris"* as a **rental preference**, which is legitimate. The one to check is that nothing produced a `districts` fact from a phrase about where someone currently *lives*:

```bash
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -c \
  "select l.name, f.key, f.value, f.evidence from lead_facts f
   join leads l on l.id=f.lead_id where f.superseded_at is null
   order by l.name, f.key;"
```

Read the `evidence` column. Every row must quote text you can find in that lead's thread. If any row's evidence isn't in the thread, layer 2 has a hole — that's a stop-and-fix, not a nit.

### Verify — superseding actually supersedes

Run the same lead twice; the second run must not duplicate rows:

```bash
cd $REPO
curl -s -X POST http://127.0.0.1:54321/functions/v1/extract-facts \
  -H 'Content-Type: application/json' -d "{\"lead_id\":\"$MARCUS\",\"force\":true}" > /dev/null
docker exec -e PGPASSWORD=postgres supabase_db_revive psql -U postgres -d postgres -tAc \
  "select key, count(*) from lead_facts where lead_id='$MARCUS' and superseded_at is null group by key order by key;"
```

Every key must appear **exactly once** with a `1`. More than one live row for a key means the supersede branch didn't fire and the FactsPanel (task 14) will render contradictory facts side by side.

---

## Step 9 — full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0; `pnpm test` reports **144 tests**.

**// SPEC-GAP: edge functions are not covered by `pnpm typecheck`.** `supabase/` is not a pnpm workspace (`pnpm-workspace.yaml` globs only `apps/*` and `packages/*`), the same gap task 8 documented for `seed.ts`. The deliberate mitigation is that all the *logic* lives in `evidence.ts`, which is typechecked and has 16 unit tests; `index.ts` is orchestration you exercise by calling it in step 8. If you want a check, `deno check` against the function is available once you have Deno locally — not required, and not wired into `pnpm typecheck`.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `failed to read file: open packages/core/src/types` | Step 1 skipped or incomplete | Trap 1 — **every** intra-core import needs `.ts`, including `import type` |
| `An import path can only end with a '.ts' extension` | Step 1's tsconfig line missing | Add `"allowImportingTsExtensions": true` to `packages/core/tsconfig.json` |
| Every `bedrooms` fact rejected as `value_evidence_mismatch` | Step 2 skipped; validator using `extractNumbers` | Trap 2 / A6 — it must call `normalizeNumbers` |
| `Relative import path "@anthropic-ai/sdk" not prefixed with...` | `supabase/functions/deno.json` missing | Step 6 |
| `ANTHROPIC_API_KEY is not set` | `serve` started without `--env-file` | `supabase functions serve --no-verify-jwt --env-file .env.local` |
| `extract (extract-v1) did not return JSON` | Model emitted prose | `call.ts` already strips fences; if it persists, check the system prompt was passed as `system`, not prepended to `user` |
| Two live rows for the same key | Supersede branch skipped | Trap 6 — `prior` lookup must filter `superseded_at is null` |
| `lead not found` on a valid uuid | Seed not run, or wrong project | `pnpm seed` |
| Jonathan Lim returns 500 | Empty-thread branch missing | Trap 5 — return zeros before the LLM call |

---

## Step 10 — Acceptance and commit

### Checklist

- [ ] Every relative import in `packages/core/src/` ends in `.ts`, including type-only ones
- [ ] `packages/core/tsconfig.json` has `allowImportingTsExtensions: true`
- [ ] `normalizeNumbers` exported; `extractNumbers` unchanged in behaviour (G3's tests green)
- [ ] `evidence.ts` implements layers 2 and 3 and **never throws** — rejections are returned
- [ ] `evidence.test.ts` includes both rejections §11 names: fabricated evidence, and verbatim-but-wrong-value
- [ ] A `bedrooms` regression test proving the ≥1000 floor doesn't apply to evidence checking
- [ ] `extract.ts` exports `{ version, system, buildUser }` with `version = 'extract-v1'`
- [ ] `deno.json` pins both npm specifiers to the versions already in `package.json`
- [ ] The function returns §8's exact response shape, including `usage`
- [ ] Superseding sets `superseded_at` and inserts — **no `UPDATE` of a fact value anywhere**
- [ ] Tested on all 6 seeded leads; Jonathan Lim returns zeros at zero cost
- [ ] Marcus has no `timeline` fact; Priya has all four required keys
- [ ] Every `evidence` value is findable in its own lead's thread
- [ ] `pnpm typecheck`, `pnpm test` (144), `pnpm --filter @revive/web build` all exit 0

### Expected tree

```
$REPO/
├── packages/core/
│   ├── tsconfig.json                    # edited: +allowImportingTsExtensions
│   └── src/
│       ├── evidence.ts                  # new
│       ├── evidence.test.ts             # new
│       ├── guardrail.ts                 # edited: +normalizeNumbers
│       ├── index.ts                     # edited: .ts extensions, +./evidence.ts
│       └── {classify,facts,mockProvider,selectStrategy}.ts   # edited: .ts extensions
├── packages/llm/src/
│   ├── index.ts                         # edited: +extractPrompt
│   └── prompts/extract.ts               # new
└── supabase/functions/
    ├── deno.json                        # new
    └── extract-facts/index.ts           # new
```

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 9: extract-facts + four-layer evidence enforcement"
```

Then update **Current state** in `CLAUDE.md`, and add amendment **A6** (below) to the amendments list.

---

## Amendment A6 — for `CLAUDE.md`

> ### A6 — the G3 normalizer's ≥1000 floor is split out for §5's evidence check
>
> §5 layer 3 says to run "the G3 number normalizer (§6.4)" over the evidence span for `budget_min`, `budget_max` and `bedrooms`. But step 4 of §6.4 ends that normalizer with `filter(n => n >= 1000)` — right for scanning a draft, fatal here: `extractNumbers("a 3 bedder")` returns `[]`, so the ±2% comparison has nothing to match and **every legitimate `bedrooms` fact is rejected as `value_evidence_mismatch`**. Measured against the real function, not inferred.
>
> **Resolution:** `guardrail.ts` exports `normalizeNumbers()` — the same pipeline (suffix multiplication, comma stripping, year whitelist) minus the magnitude filter — and `extractNumbers()` becomes `normalizeNumbers(...).filter(n => n >= 1000)`. G3's behaviour is bit-for-bit unchanged and its tests stay green. `evidence.ts` uses `normalizeNumbers`. There is still exactly one normalizer, which was §5's actual intent in pointing at §6.4.
>
> Also settled here: `packages/core` now uses `.ts` extensions on every relative import (with `allowImportingTsExtensions` in its tsconfig), because the Supabase edge runtime resolves import specifiers **before** stripping types — so even `import type { Fact } from './types'` fails there. This is what "Deno edge functions import it from source starting at task 9" costs in practice.

---

## Next

**Task 10 — `ingest-inbound`** (§8, §6.2). Inserts a message, runs the opt-out and snooze keyword lists deterministically (no LLM), sets `last_inbound_at = sent_at`, resets `touch_count = 0`, then calls this function. Two things carry over from here: it reuses `supabase/functions/deno.json`, and its `facts_refreshed` response field is this function's `inserted` count.

Note the seeded `Kelvin Ong` already has `opted_out = true` set directly by the seed, because `ingest-inbound` didn't exist yet — his final inbound (*"pls stop messaging me, already bought"*) carries two §6.2 keywords and is the natural test payload for it.

**`0004_approve_draft.sql`** (amendment A1) is still outstanding and must land before task 13.
