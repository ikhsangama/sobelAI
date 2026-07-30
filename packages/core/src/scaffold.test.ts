// Throwaway smoke test — proves the root vitest `projects` glob actually
// discovers files inside a workspace package. Delete once classify.test.ts
// (task 4) makes this redundant.
import { expect, it } from "vitest"

it("runner resolves", () => {
  expect(1).toBe(1)
})
