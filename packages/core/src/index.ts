export * from './types'
export * from './sg-rules'
export * from './facts'

// Exercised by apps/web/src/App.tsx so the workspace import path
// (source-only @revive/core exports, resolved via Vite's dep prebundler)
// is actually proven at scaffold time instead of only declared.
// Removed at task 4, alongside scaffold.test.ts.
export const SCAFFOLD_OK = true
