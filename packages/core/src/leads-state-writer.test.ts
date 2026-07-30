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
