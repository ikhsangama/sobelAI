# Task 4 — `classify.ts` + `classify.test.ts`

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 4:

> `classify.ts` + `classify.test.ts` (§6.1). All boundary tests pass, including a test that `leads.state` is never written outside `generate-drafts`.

**Outcome:** the first real logic in the repo — a pure function that decides a lead's state from timestamps, with the boundary tests that pin it. Task 3's scaffolding leftovers (`SCAFFOLD_OK`, `scaffold.test.ts`) are retired here.

**What is NOT in this task:**

| Thing | Lands at |
|---|---|
| `selectStrategy()` + the 10 `strategy_rules` rows | Task 5 |
| `guardrail()` G1–G5 | Task 6 |
| `MockProvider` | Task 7 |
| `generate-drafts` (the only thing that ever *writes* `leads.state`) | Task 11 |

Everything you need to type is written out in full below. You should not need to open `planning-overview.md` to complete this task — only to understand *why* something is the way it is.

Work top to bottom. Every step ends with a **Verify** block.

---

## Read this before you start

### Five traps

**Trap 1 — `diffDays` is not in the contract. It floors. Do not make it fractional.**
§6.1 calls `diffDays(now, ...)` twice but never defines it — this is the one genuine gap in this task. It returns **whole days, floored**. That isn't a guess; two places in the contract pin it:

- §6.1's own fallthrough note says a `new` lead "silently becomes `cold` via the `classify()` fall-through **on day 3**." With `daysSinceCreated <= 2` that is only true if 2.9 days floors to `2` (still `new`) and 3.0 days floors to `3` (now `cold`). A fractional `diffDays` would flip the lead at 2.0 days exactly, contradicting the sentence.
- §8's trace shows `"days_since_inbound": 21` — an integer, not `21.4`.

So: `Math.floor((now - then) / 86_400_000)`. Mark it `// SPEC-GAP:` anyway, because the *derivation* is sound but the function signature was never written down.

**Trap 2 — the three short-circuits must stay in order, and `disqualified` does NOT map to a state of the same name.**
`opted_out` is checked first, then `handed_off`, then `disqualified`. A `disqualified` lead returns **`'do_not_contact'`** — there is no `'disqualified'` member in `LeadState` (check `types.ts`: the six members are `new`, `warm`, `cold`, `dormant`, `handed_off`, `do_not_contact`). `qual_status` and `lead_state` are different enums that happen to share two names; don't map one onto the other.

**Trap 3 — `new` requires all three conditions, not one.**
`touch_count === 0` **and** `last_inbound_at === null` **and** `daysSinceCreated <= 2`. Dropping any one of them silently mislabels leads: a lead the agent already messaged twice would read as `new`, and `new_ad_lead` (priority 75, task 5) would fire on it.

**Trap 4 — deleting `SCAFFOLD_OK` means editing `apps/web/src/App.tsx` too.**
This is the exact inverse of task 3's trap 1. `App.tsx:1` imports `SCAFFOLD_OK` and line 9 renders it. Remove the export without touching `App.tsx` and `pnpm --filter @revive/web build` fails. Do both, in the same step.

**Trap 5 — `classify()` has no timezone logic. Do not add any.**
`SGT_OFFSET_HOURS` exists in `sg-rules.ts`, and it is tempting to reach for it here. Don't. `classify()` measures elapsed time between two instants, which is timezone-independent. SGT only matters for *quiet hours*, which live in `approve_draft` (§8), not here. Adding an offset would shift every boundary by 8 hours.

### Conventions

- All commands run from the repo root unless a step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.

---

## Step 1 — Give `packages/core` Node types (needed for step 4's test only)

Step 4's guard test reads files off disk, so it needs `node:fs`. `packages/core/tsconfig.json` currently sets `"lib": ["ES2022"]` with no `types`, so `import ... from 'node:fs'` fails `pnpm typecheck` with `Cannot find module 'node:fs'`.

In `$REPO/packages/core/tsconfig.json`, add `"types": ["node"]` inside `compilerOptions`, right after the `"lib"` line:

```json
    "lib": ["ES2022"],
    "types": ["node"],
```

In `$REPO/packages/core/package.json`, add `@types/node` to `devDependencies` (keep `vitest`):

```json
  "devDependencies": {
    "@types/node": "^24.13.2",
    "vitest": "^4.0.0"
  }
```

Then:

```bash
cd $REPO && pnpm install
```

**This does not violate the zero-dependency rule.** Task 1's trap 3 says `packages/core` must have no **runtime** dependencies, because Deno edge functions import it from source starting at task 9. `@types/node` is a `devDependency` and a types-only package — it emits nothing and is invisible at runtime. `packages/core/package.json` must still have **no `dependencies` key at all**.

### Verify

```bash
cd $REPO
grep -c '"types": \["node"\]' packages/core/tsconfig.json   # 1
grep -c '"dependencies"'      packages/core/package.json    # 0
```

Expected: `1`, then `0`. (`grep -c` printing `0` exits non-zero — that is the passing result for the second one.)

---

## Step 2 — `packages/core/src/classify.ts`

Create the file with exactly this content. The body of `classify()` is transcribed verbatim from §6.1 — do not restructure it, do not collapse the four `if`s into a ternary chain, do not "simplify" the repeated `daysSinceInbound !== null` checks. It reads as slightly redundant on purpose: each line maps to one row of the state table, which is what makes the boundary tests readable.

```ts
import type { LeadRow, LeadState } from './types'

const MS_PER_DAY = 86_400_000

/**
 * Whole days elapsed from `then` to `now`, floored.
 *
 * // SPEC-GAP: §6.1 calls diffDays twice but never defines it. Floored whole
 * days is derived, not invented: §6.1's own fallthrough note says a `new`
 * lead "becomes cold via the classify() fall-through on day 3", which only
 * holds if 2.9 days floors to 2 (still `new`, since the test is `<= 2`) and
 * 3.0 floors to 3. §8's trace agrees — `"days_since_inbound": 21` is an
 * integer. A fractional diffDays would flip that lead at exactly 2.0 days
 * and contradict both.
 *
 * Exported because task 5 needs the same arithmetic for `days_since_outbound`
 * and `days_silent` (§6.3). §1's file list has no `time.ts`, so it lives here
 * rather than in a new module the contract doesn't name.
 *
 * Accepts a string because row timestamps arrive as ISO strings from
 * PostgREST (see the header of `types.ts`); accepts a Date for callers that
 * already have one. Returns a negative number if `then` is in the future —
 * that is left to fall through the normal branches rather than clamped,
 * since a future timestamp means bad data, and `warm` is the safe reading
 * (the AI stays out of it).
 */
export function diffDays(now: Date, then: string | Date): number {
  const thenMs = then instanceof Date ? then.getTime() : new Date(then).getTime()
  return Math.floor((now.getTime() - thenMs) / MS_PER_DAY)
}

/**
 * The only thing in the system that decides a lead's state (§6.1).
 *
 * Pure: no clock, no I/O. `now` is injected so the eval harness (task 12) can
 * test time-dependent behaviour without mocking `Date` — contract rule 3.
 *
 * Note there is no timezone handling here and none is needed: this measures
 * elapsed time between two instants. SGT only matters for quiet hours, which
 * run in `approve_draft` (§8).
 */
export function classify(lead: LeadRow, now: Date): LeadState {
  if (lead.opted_out) return 'do_not_contact';
  if (lead.qualification_status === 'handed_off') return 'handed_off';
  if (lead.qualification_status === 'disqualified') return 'do_not_contact';

  const daysSinceInbound = lead.last_inbound_at
    ? diffDays(now, lead.last_inbound_at) : null;
  const daysSinceCreated = diffDays(now, lead.created_at);

  if (lead.touch_count === 0 && daysSinceInbound === null && daysSinceCreated <= 2)
    return 'new';
  if (daysSinceInbound !== null && daysSinceInbound <= 7)  return 'warm';
  if (daysSinceInbound !== null && daysSinceInbound <= 45)  return 'cold';
  if (daysSinceInbound !== null)                            return 'dormant';
  return daysSinceCreated <= 45 ? 'cold' : 'dormant';
}
```

### Verify

```bash
cd $REPO
grep -c "^export function" packages/core/src/classify.ts   # 2
grep -c "SGT_OFFSET_HOURS" packages/core/src/classify.ts   # 0 — trap 5
```

Expected: `2`, then `0`.

---

## Step 3 — `packages/core/src/classify.test.ts`

The boundary tests §6.1 asks for: "exact boundaries at 2/7/45 days, null-inbound branches, all three short-circuits."

Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import type { LeadRow } from './types'
import { classify, diffDays } from './classify'

/** Fixed clock. Every case is expressed as an offset from this instant. */
const NOW = new Date('2026-07-30T10:00:00+08:00')

/** ISO timestamp for exactly `days` before NOW. Fractions allowed. */
function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString()
}

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-id',
    agent_id: 'agent-id',
    name: 'Marcus',
    phone: '+6580000000',
    source: 'propertyguru',
    state: 'new',
    qualification_status: 'unqualified',
    last_inbound_at: null,
    last_outbound_at: null,
    touch_count: 0,
    snooze_until: null,
    opted_out: false,
    created_at: daysBefore(0),
    ...overrides,
  }
}

describe('diffDays', () => {
  it('returns whole days for an exact multiple', () => {
    expect(diffDays(NOW, daysBefore(7))).toBe(7)
  })

  it('floors a partial day rather than rounding', () => {
    expect(diffDays(NOW, daysBefore(7.9))).toBe(7)
  })

  it('ticks over only once the full day has elapsed', () => {
    expect(diffDays(NOW, daysBefore(8))).toBe(8)
  })

  it('returns 0 for the same instant', () => {
    expect(diffDays(NOW, daysBefore(0))).toBe(0)
  })

  it('returns a negative number for a future timestamp', () => {
    expect(diffDays(NOW, daysBefore(-3))).toBe(-3)
  })
})

describe('classify — short circuits', () => {
  it('opted_out wins over everything else', () => {
    // Inbound yesterday would otherwise read as `warm`.
    expect(classify(lead({ opted_out: true, last_inbound_at: daysBefore(1) }), NOW))
      .toBe('do_not_contact')
  })

  it('handed_off maps to its own state', () => {
    expect(classify(lead({ qualification_status: 'handed_off' }), NOW))
      .toBe('handed_off')
  })

  it('disqualified maps to do_not_contact, not to a state of the same name', () => {
    expect(classify(lead({ qualification_status: 'disqualified' }), NOW))
      .toBe('do_not_contact')
  })

  it('opted_out is checked before qualification_status', () => {
    expect(classify(
      lead({ opted_out: true, qualification_status: 'handed_off' }),
      NOW,
    )).toBe('do_not_contact')
  })
})

describe('classify — the `new` window (boundary at 2 days)', () => {
  it('is new on the day it was created', () => {
    expect(classify(lead({ created_at: daysBefore(0) }), NOW)).toBe('new')
  })

  it('is still new at exactly 2 days', () => {
    expect(classify(lead({ created_at: daysBefore(2) }), NOW)).toBe('new')
  })

  it('falls through to cold on day 3', () => {
    // §6.1's documented cold-start: a non-ad lead gets no rule for two days,
    // then becomes cold and starts receiving gentle_check_in.
    expect(classify(lead({ created_at: daysBefore(3) }), NOW)).toBe('cold')
  })

  it('is not new once the agent has touched it', () => {
    expect(classify(lead({ created_at: daysBefore(1), touch_count: 1 }), NOW))
      .toBe('cold')
  })

  it('is not new once the lead has replied', () => {
    expect(classify(
      lead({ created_at: daysBefore(1), last_inbound_at: daysBefore(1) }),
      NOW,
    )).toBe('warm')
  })
})

describe('classify — warm/cold boundary at 7 days', () => {
  it('is warm when the lead replied today', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(0), touch_count: 1 }), NOW))
      .toBe('warm')
  })

  it('is still warm at exactly 7 days', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(7), touch_count: 1 }), NOW))
      .toBe('warm')
  })

  it('turns cold at 8 days', () => {
    expect(classify(lead({ last_inbound_at: daysBefore(8), touch_count: 1 }), NOW))
      .toBe('cold')
  })
})

describe('classify — cold/dormant boundary at 45 days', () => {
  it('is still cold at exactly 45 days', () => {
    expect(classify(
      lead({ last_inbound_at: daysBefore(45), created_at: daysBefore(60), touch_count: 1 }),
      NOW,
    )).toBe('cold')
  })

  it('turns dormant at 46 days', () => {
    expect(classify(
      lead({ last_inbound_at: daysBefore(46), created_at: daysBefore(60), touch_count: 1 }),
      NOW,
    )).toBe('dormant')
  })
})

describe('classify — null-inbound fallthrough (a lead that never replied)', () => {
  it('is cold at exactly 45 days since creation', () => {
    expect(classify(
      lead({ last_inbound_at: null, created_at: daysBefore(45), touch_count: 1 }),
      NOW,
    )).toBe('cold')
  })

  it('is dormant at 46 days since creation', () => {
    expect(classify(
      lead({ last_inbound_at: null, created_at: daysBefore(46), touch_count: 1 }),
      NOW,
    )).toBe('dormant')
  })
})
```

Two notes on the fixtures, so the numbers don't look arbitrary:

- The 45/46-day cases set `created_at: daysBefore(60)` explicitly. Without it the factory default (`daysBefore(0)`) would put creation *after* the inbound message, which is impossible and would make the test pass for the wrong reason.
- `touch_count: 1` appears on most non-`new` cases to keep the `new` branch from competing. It isn't load-bearing where `last_inbound_at` is set (the null check already excludes `new`), but it keeps every fixture a realistic lead.

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -6
```

21 tests in this file pass.

---

## Step 4 — `packages/core/src/leads-state-writer.test.ts`

§11 task 4 asks for "a test that `leads.state` is never written outside `generate-drafts`." §6.1 explains why: the column is a denormalized cache, `classify()` is the only thing that decides it, and `generate-drafts` is the only thing that writes it — *"`ingest-inbound` never touches it, even though it does touch `opted_out`."*

**At task 4 this test passes vacuously** — `supabase/functions/` doesn't exist yet. That is expected and fine. It is a tripwire armed now so it fires at **task 10**, when someone writing `ingest-inbound` reaches for `state` alongside `opted_out`, which is exactly the mistake §6.1 warns about.

Create the file with exactly this content:

```ts
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The single sanctioned writer of leads.state (§6.1). */
const ALLOWED_WRITERS = ['supabase/functions/generate-drafts/index.ts']

const SEARCH_ROOTS = ['supabase/functions', 'apps/web/src', 'packages']

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return []
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/**
 * Heuristic, deliberately: a tripwire, not a proof. Catches the two shapes a
 * state write realistically takes — a supabase-js update on the leads table
 * carrying a `state:` key, and raw SQL doing `update leads set ... state =`.
 */
function writesLeadState(source: string): boolean {
  const viaClient =
    /from\(\s*['"]leads['"]\s*\)/.test(source) &&
    /\.update\s*\(/.test(source) &&
    /\bstate\s*:/.test(source)
  const viaSql = /update\s+leads\s+set[\s\S]{0,300}?\bstate\s*=/i.test(source)
  return viaClient || viaSql
}

describe('leads.state has exactly one writer (§6.1)', () => {
  it('no file outside generate-drafts writes leads.state', () => {
    const offenders = SEARCH_ROOTS
      .flatMap((root) => walk(join(REPO_ROOT, root)))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      // Test files describe the pattern in order to detect it.
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => writesLeadState(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).replaceAll('\\', '/'))
      .filter((rel) => !ALLOWED_WRITERS.includes(rel))

    expect(offenders).toEqual([])
  })
})
```

The `.test.ts` exclusion is not optional: this file contains the detection patterns as regex literals, so without it the test reports itself as an offender.

### Verify

```bash
cd $REPO && pnpm test 2>&1 | tail -6
```

Passes. To prove it isn't vacuous, temporarily create a file that trips it:

```bash
cd $REPO
mkdir -p supabase/functions/ingest-inbound
cat > supabase/functions/ingest-inbound/index.ts <<'EOF'
await supabase.from('leads').update({ state: 'warm', opted_out: true }).eq('id', leadId)
EOF
pnpm test 2>&1 | grep -A4 "leads.state"
rm -rf supabase/functions/ingest-inbound
```

The run in the middle **must fail**, naming `supabase/functions/ingest-inbound/index.ts`. Then confirm `pnpm test` is green again after the `rm`. A guard test you never saw fail is a guard test you don't know works.

---

## Step 5 — Retire the scaffold

Three edits, all in one step because they only work together (trap 4).

**5a.** Delete `$REPO/packages/core/src/scaffold.test.ts`. `classify.test.ts` now proves the vitest `projects` glob discovers files in workspace packages, which is the only thing that file existed for.

**5b.** In `$REPO/packages/core/src/index.ts`, delete the `SCAFFOLD_OK` export and its comment, leaving only the three re-exports:

```ts
export * from './types'
export * from './sg-rules'
export * from './facts'
export * from './classify'
```

Note the added fourth line — `classify.ts` joins the barrel.

**5c.** In `$REPO/apps/web/src/App.tsx`, drop the import and the paragraph that renders it:

```tsx
import { Button } from "@/components/ui/button"

export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50">
      <h1 className="text-2xl font-semibold text-neutral-900">Revive</h1>
      <Button>Test button</Button>
    </div>
  )
}
```

One consequence worth knowing rather than discovering later: nothing in `apps/web` imports `@revive/core` any more, so the web build stops exercising the workspace import path it was proving at task 1. That coverage returns at task 13, when `/queue` imports real types. `pnpm typecheck` still compiles the package either way.

### Verify

```bash
cd $REPO
test ! -f packages/core/src/scaffold.test.ts && echo "scaffold.test.ts gone"
grep -rn "SCAFFOLD_OK" packages apps --include=*.ts --include=*.tsx || echo "no SCAFFOLD_OK references remain"
grep -c "export \*" packages/core/src/index.ts   # 4
```

Expected: the two messages, then `4`.

---

## Step 6 — Full verification

```bash
cd $REPO
pnpm typecheck
pnpm test
pnpm --filter @revive/web build
```

All three exit 0.

`pnpm test` should report **3 test files** — `classify.test.ts`, `leads-state-writer.test.ts`, `facts.test.ts` (from task 3) — and **25 tests** (21 + 1 + 3). Treat those counts as informational; the pass/fail is what matters.

The web build is the trap 4 check: it fails if `SCAFFOLD_OK` was removed from `index.ts` without updating `App.tsx`.

Finally, confirm `classify` is reachable through the package entry point the way task 5 and the edge functions will import it:

```bash
cd $REPO && node --input-type=module -e "
import { classify, diffDays } from './packages/core/src/classify.ts'
const now = new Date('2026-07-30T10:00:00+08:00')
const base = { id:'l', agent_id:'a', name:'M', phone:'+65', source:'propertyguru',
  state:'new', qualification_status:'unqualified', last_inbound_at:null,
  last_outbound_at:null, touch_count:0, snooze_until:null, opted_out:false,
  created_at:new Date(now.getTime()).toISOString() }
const ago = d => new Date(now.getTime() - d*86400000).toISOString()
console.log('fresh            ->', classify(base, now))
console.log('replied 3d ago   ->', classify({...base, touch_count:1, last_inbound_at:ago(3)}, now))
console.log('replied 30d ago  ->', classify({...base, touch_count:1, last_inbound_at:ago(30), created_at:ago(60)}, now))
console.log('replied 90d ago  ->', classify({...base, touch_count:1, last_inbound_at:ago(90), created_at:ago(120)}, now))
console.log('opted out        ->', classify({...base, opted_out:true}, now))
console.log('diffDays 7.9d    ->', diffDays(now, ago(7.9)))
"
```

Expected, exactly:

```
fresh            -> new
replied 3d ago   -> warm
replied 30d ago  -> cold
replied 90d ago  -> dormant
opted out        -> do_not_contact
diffDays 7.9d    -> 7
```

Import the leaf file directly, not `index.ts` — Node strips TypeScript types but does not resolve the extensionless specifiers that `moduleResolution: "bundler"` permits, so the barrel throws `ERR_MODULE_NOT_FOUND`. Same limitation as task 3's step 5; not a defect in your code.

---

## Failure signatures

| Error | Cause | Fix |
|---|---|---|
| `Cannot find module 'node:fs'` | Step 1 skipped | Add `"types": ["node"]` to `packages/core/tsconfig.json` and `@types/node` to its devDependencies |
| `Module '"@revive/core"' has no exported member 'SCAFFOLD_OK'` on the web build | 5b done without 5c | Apply 5c — trap 4 |
| `leads-state-writer` test reports itself as an offender | The `.test.ts` filter was dropped | Restore `.filter((f) => !f.endsWith('.test.ts'))` |
| Boundary test at 7 days returns `cold` instead of `warm` | `diffDays` isn't flooring, or uses `<` where §6.1 has `<=` | Both comparisons in §6.1 are `<=`; `diffDays` ends in `Math.floor` |
| Every boundary is off by roughly a third of a day | SGT offset applied inside `classify` | Trap 5 — remove it |
| `Type '"disqualified"' is not assignable to type 'LeadState'` | Trap 2 | `disqualified` returns `'do_not_contact'` |
| 45/46-day tests both return `dormant` | `created_at` left at the factory default, so creation postdates the inbound | Set `created_at: daysBefore(60)` on those cases |

---

## Step 7 — Acceptance and commit

### Checklist

- [ ] `diffDays` floors, is exported, and carries its `// SPEC-GAP:` note
- [ ] `classify()` body matches §6.1 line for line, including the `<=` comparisons
- [ ] No timezone/SGT logic anywhere in `classify.ts`
- [ ] All three short-circuits tested, including `opted_out` beating `handed_off`
- [ ] Boundaries tested at 2/3, 7/8, and 45/46 days
- [ ] Null-inbound fallthrough tested at 45 and 46 days since creation
- [ ] The `leads.state` guard test exists **and was seen to fail** against a deliberate violation
- [ ] `scaffold.test.ts` deleted, `SCAFFOLD_OK` gone from `index.ts` and `App.tsx`
- [ ] `index.ts` re-exports `./classify`
- [ ] `packages/core/package.json` still has **no `dependencies` key**
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --filter @revive/web build` all exit 0
- [ ] No `selectStrategy`, `guardrail`, or `strategy_rules` seed rows — those are tasks 5 and 6

### Expected tree

```
$REPO/
├── apps/web/src/App.tsx                          # edited: SCAFFOLD_OK removed
└── packages/core/
    ├── package.json                              # edited: @types/node devDep
    ├── tsconfig.json                             # edited: types: ["node"]
    └── src/
        ├── classify.ts                           # new
        ├── classify.test.ts                      # new
        ├── leads-state-writer.test.ts            # new
        ├── index.ts                              # edited: +./classify, -SCAFFOLD_OK
        └── scaffold.test.ts                      # DELETED
```

Nothing under `supabase/`, `packages/llm`, or `packages/eval` changes.

### Commit

```bash
cd $REPO
git status
git add -A
git commit -m "Task 4: classify + boundary tests"
```

Then update the **Current state** section of `CLAUDE.md` to task 4 complete, task 5 next.

---

## Next

Task 5 — `selectStrategy.ts` + tests + the `strategy_rules` seed (§6.3). The priority-ordered rule table that turns a `LeadState` into one of seven strategies.

Four things to know before starting it:

- **It is 10 rows, not 11.** `cooldown_active` is a **post-selection check**, not a table row — an earlier draft had it competing at priority 85 with `days_since_outbound < 0`, which is always false and circular besides. `types.ts` already encodes this: `StrategyRuleRow.name` is typed `SeededRuleName` (the 10 real rows), while the wider `RuleName` (which adds `cooldown_active` and `no_rule_matched`) is only for `trace.rule_fired`. If you find yourself widening that type to make a seed row compile, stop — the type is right and the row is wrong.
- **`diffDays` from this task is what computes `days_since_outbound` and `days_silent`.** Import it; don't write a second copy.
- **`warm_human_handles` matches `state == 'warm' && touch_count > 0`**, not `state == 'warm'` alone. Without the second clause it suppresses a fresh Meta ad lead before `new_ad_lead` can fire, because that lead's first inbound makes `classify()` return `warm` immediately.
- **Test that a zero-touch `new` + `meta_ad` lead reaches `instant_qualify`** rather than being swallowed by `warm_human_handles` — §11 task 5 calls for this case specifically.
