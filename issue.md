# Task 1 — Scaffold the workspace

**Tracks `planning-overview.md` as revised post-architectural-review** (17 tasks, `/settings` cut, eval harness at task 12). If the task numbers cited below don't line up with §11, this file is out of date — trust §11.

**Source:** `planning-overview.md` §11, task 1:

> `pnpm init` workspaces; scaffold `apps/web` (Vite React TS), `packages/core|llm|eval`; Tailwind + shadcn init; `supabase init` + `supabase start`. Verify `pnpm dev` renders.

**Outcome:** an empty-but-correct monorepo. `pnpm dev` serves a Tailwind-styled page with a shadcn button; local Supabase is running; `pnpm test` resolves. **No business logic** — that starts at task 3.

Work top to bottom. Every step ends with a **Verify** block. If a Verify fails, fix it before moving on — later steps assume earlier ones worked.

---

## Read this before you start

### Versions

**React 19 + Vite 8 + Tailwind v4 + shadcn 4.x.** This matches `planning-overview.md` §2 — the contract was updated to React 19, so there is nothing to reconcile and no downgrade step anywhere in this file. You take what the CLIs give you.

The practical consequence is Tailwind v4, which is a genuinely different setup from v3 — see trap 2 below before you start step 3.

The rest of §2 is unchanged: TypeScript, shadcn (Radix), TanStack React Query, Supabase local, pnpm workspaces, Vitest.

### Three traps

These will produce a repo that *looks* right and is wrong. Read them now, not after.

**Trap 1 — Never run `shadcn init --monorepo`.**
That flag scaffolds a Turborepo with a `packages/ui` workspace. We do not want that. The spec wants `packages/core`, `packages/llm`, `packages/eval`, and shadcn components living at `apps/web/src/components/ui/`. You will `cd apps/web` and run plain `shadcn init` there, as if it were a standalone app.

**Trap 2 — Tailwind v4 has no config file.**
If you know Tailwind v3, forget it for this repo. There is **no** `tailwind.config.js`, **no** `postcss.config.js`, and `npx tailwindcss init` does not exist any more. Tailwind v4 is: install `@tailwindcss/vite`, add the plugin to `vite.config.ts`, and put `@import "tailwindcss";` in your CSS. That's the whole setup. If you find yourself writing `@tailwind base;` you have gone wrong.

**Trap 3 — `packages/core` must have zero runtime dependencies and export raw `.ts`.**
Starting at task 9, Deno edge functions import from `packages/core`. If you set it up now to build into `dist/` and point `main` there, that import breaks later and is painful to unwind. Its `exports` field points at `./src/index.ts`. Nothing goes in its `dependencies`.

### Conventions

- All commands run from the repo root unless the step says otherwise.
- `$REPO` means the repo root — the folder containing `planning-overview.md`.
- Workspace packages are named `@revive/web`, `@revive/core`, `@revive/llm`, `@revive/eval`.
  `// SPEC-GAP:` §1 never names the packages. Picked the simplest scheme.

---

## Step 0 — Docker preflight

`supabase start` runs Postgres and friends in Docker containers. **This is currently broken on this machine** and will stop you at step 8 if you skip this.

Docker Desktop is installed on Windows, but the daemon is not running and WSL integration is not enabled for this distro.

### Fix it

1. Launch **Docker Desktop** on Windows. Wait for the whale icon in the system tray to stop animating — "Docker Desktop is running".
2. In Docker Desktop: **Settings → Resources → WSL Integration**.
3. Enable **"Enable integration with my default WSL distro"**, and toggle on this specific distro in the list below it.
4. Click **Apply & Restart**.
5. Close and reopen your WSL terminal. The integration only appears in newly-started shells.

### Verify

```bash
docker ps
```

**Expected** — a header row, with or without containers under it:

```
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
```

**Failure signatures and what they mean:**

| Output | Cause | Fix |
|---|---|---|
| `The command 'docker' could not be found in this WSL 2 distro.` | WSL integration off | Steps 2–4 above, then open a new terminal |
| `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Docker Desktop not running | Launch Docker Desktop, wait for it to finish starting |
| `permission denied while trying to connect to the Docker daemon socket` | User not in `docker` group | `sudo usermod -aG docker $USER`, then fully restart WSL: `wsl --shutdown` from Windows PowerShell |

Do not continue until `docker ps` prints the header row.

### Optional: update the Supabase CLI

```bash
supabase --version
```

2.54.11 is installed; 2.110.0 is current. Not blocking — upgrade only if you hit a CLI bug later.

---

## Step 1 — Workspace root

**Goal:** turn the repo root into a pnpm workspace.

```bash
cd $REPO
pnpm init
```

Then **replace** the generated `package.json` entirely:

```json
{
  "name": "revive",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.26.0",
  "scripts": {
    "dev": "pnpm --filter @revive/web dev",
    "build": "pnpm --filter @revive/web build",
    "test": "vitest run",
    "eval": "pnpm --filter @revive/eval start"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.0.0"
  }
}
```

Two version notes, so neither looks like an oversight:

- **`vitest` must be `^4`**, not `^3` — the `vitest.config.ts` in step 6 uses the `projects` key, which doesn't exist in Vitest 3.0. A `^3.0.0` range can resolve to a version where root `pnpm test` fails on config resolution.
- **`typescript` is deliberately pinned to `^5.7`**, not the current `latest`. TypeScript 7 is the native-port rewrite; 5.x is the safe choice for a one-day build and nothing here needs 7.

`// SPEC-GAP:` §11 doesn't specify root script wiring. `dev`/`build` delegate to the web app; `test` runs Vitest across the workspace (step 6); `eval` is the script §10 promises, stubbed until task 12.

Set `packageManager` to whatever `pnpm -v` actually reports on your machine.

Create **`pnpm-workspace.yaml`**:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create **`.gitignore`**:

```gitignore
node_modules/
dist/
.env.local
.env
*.log
.DS_Store
.vite/
coverage/
supabase/.branches/
supabase/.temp/
```

Create **`.env.local.example`** — this one is committed, as documentation of what's needed:

```bash
# Client-side (Vite exposes anything prefixed VITE_ to the browser)
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=

# Server-side ONLY. Never prefix with VITE_ — that would ship the key to the browser.
# Used exclusively by Supabase edge functions.
ANTHROPIC_API_KEY=
```

Real values get filled into `.env.local` (gitignored) at step 8.

### Verify

```bash
ls -1 package.json pnpm-workspace.yaml .gitignore .env.local.example
```

All four listed, no errors.

---

## Step 2 — Scaffold `apps/web`

```bash
cd $REPO
pnpm create vite apps/web --template react-ts
```

If it prompts to pick a framework or variant, the `--template react-ts` flag should have skipped it — if you're still asked, choose **React**, then **TypeScript**.

Do **not** run the `npm install` / `cd apps/web` instructions it prints at the end. We install from the root instead.

Open `apps/web/package.json` and change the name:

```json
{
  "name": "@revive/web",
  ...
}
```

Then install from the root so pnpm links the workspace:

```bash
cd $REPO
pnpm install
```

### Verify

```bash
pnpm --filter @revive/web exec node -e "console.log('web package resolves')"
```

Prints `web package resolves`. If pnpm says the filter matched no projects, the `name` edit didn't save or `pnpm-workspace.yaml` is wrong.

---

## Step 3 — Tailwind v4

**Re-read Trap 2 before this step.**

```bash
cd $REPO
pnpm --filter @revive/web add tailwindcss @tailwindcss/vite
pnpm --filter @revive/web add -D @types/node
```

**Replace** the entire contents of `apps/web/src/index.css` with one line:

```css
@import "tailwindcss";
```

Delete everything else that was in that file. The Vite template ships a pile of demo CSS that will fight your styles.

**Replace** `apps/web/vite.config.ts`:

```ts
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
```

Add the path alias to **both** tsconfig files — shadcn's CLI reads them and will refuse to run if either is missing.

In `apps/web/tsconfig.json`, add to `compilerOptions` (create the key if the file only has `references`):

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

In `apps/web/tsconfig.app.json`, add the same two keys inside its existing `compilerOptions`:

```json
"baseUrl": ".",
"paths": {
  "@/*": ["./src/*"]
}
```

Also delete `apps/web/src/App.css` and remove its import from `App.tsx` — more template CSS that will interfere.

### Verify

```bash
cd $REPO && pnpm --filter @revive/web build
```

Build succeeds. Also confirm there is **no** `tailwind.config.js` and **no** `postcss.config.js` anywhere:

```bash
find apps/web -maxdepth 2 -name "tailwind.config.*" -o -maxdepth 2 -name "postcss.config.*"
```

Prints nothing. If either exists, you followed a Tailwind v3 guide — delete them.

---

## Step 4 — shadcn init

**Re-read Trap 1 before this step.** No `--monorepo` flag.

```bash
cd $REPO/apps/web
pnpm dlx shadcn@latest init
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Base color | **Neutral** — §9 calls for a neutral, dense operator tool |
| CSS file / config detection | Accept the detected defaults (`src/index.css`, the `@` alias) |
| Anything about a monorepo | **No** |

Now prove the pipeline works end to end by adding one component:

```bash
cd $REPO/apps/web
pnpm dlx shadcn@latest add button
```

### Verify

```bash
ls $REPO/apps/web/components.json $REPO/apps/web/src/lib/utils.ts $REPO/apps/web/src/components/ui/button.tsx
```

All three exist. The button path is the important one — it must be `apps/web/src/components/ui/`, matching §1.

```bash
ls -d $REPO/packages/ui 2>/dev/null && echo "WRONG — you used --monorepo, delete packages/ui and redo step 4"
```

Should print nothing.

---

## Step 5 — The three packages

**Re-read Trap 3 before this step.**

Create the directory skeleton:

```bash
cd $REPO
mkdir -p packages/core/src packages/llm/src packages/eval/src
```

### `packages/core`

Pure logic, no I/O. Deno edge functions will import it directly from source starting at task 9, so it stays dependency-free and exports `.ts`.

`packages/core/package.json`:

```json
{
  "name": "@revive/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^4.0.0"
  }
}
```

There is deliberately no `dependencies` key and no build step. Keep it that way.

`packages/core/src/index.ts`:

```ts
// Task 3 fills this in: types.ts, sg-rules.ts, facts.ts
export {}
```

### `packages/llm`

Wraps the Anthropic SDK. Every LLM call in the repo goes through `src/call.ts` (contract rule 4).

`packages/llm/package.json`:

```json
{
  "name": "@revive/llm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.115.0",
    "@revive/core": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^4.0.0"
  }
}
```

The SDK is on `0.x`, where a caret range does **not** cross minor versions — `^0.115.0` gets patches only. Check `npm view @anthropic-ai/sdk version` and use whatever is current; an older pin here is a real downgrade, not a harmless one.

`packages/llm/src/index.ts`:

```ts
// Task 7 fills this in: call.ts + prompts/
export {}
```

### `packages/eval`

`packages/eval/package.json`:

```json
{
  "name": "@revive/eval",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/run.ts"
  },
  "dependencies": {
    "@revive/core": "workspace:*",
    "@revive/llm": "workspace:*",
    "@supabase/supabase-js": "^2.111.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "vitest": "^4.0.0"
  }
}
```

`@supabase/supabase-js` is here even though this package has no code yet: §10 has the eval runner truncating tables and inserting fixture rows directly against local Postgres between runs, so it needs a client of its own. Adding it now avoids a dependency detour in the middle of task 12.

`packages/eval/src/run.ts`:

```ts
// Task 12 fills this in: the eval harness
console.log("eval harness not implemented yet — see task 12")
```

Create `packages/eval/fixtures/` as an empty directory (task 12 populates it):

```bash
mkdir -p $REPO/packages/eval/fixtures
```

### Shared tsconfig

Each package needs one. Write the same file to all three — `packages/core/tsconfig.json`, `packages/llm/tsconfig.json`, `packages/eval/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

Then install so pnpm wires the `workspace:*` links:

```bash
cd $REPO && pnpm install
```

### Verify

```bash
cd $REPO && pnpm -r list --depth -1
```

Lists four packages: `@revive/web`, `@revive/core`, `@revive/llm`, `@revive/eval`.

```bash
cat $REPO/packages/core/package.json | grep -c '"dependencies"'
```

Prints `0`. If it prints `1`, something added a dependency to core — remove it.

---

## Step 6 — Vitest

`pnpm test` at the root should run every package's tests. There are none yet; the point is that the runner resolves cleanly so tasks 4–6 can just write `*.test.ts` files.

Create `$REPO/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
})
```

Install the root dev dependencies:

```bash
cd $REPO && pnpm install
```

### Verify

```bash
cd $REPO && pnpm test
```

Exits 0. "No test files found" is the expected and correct result at this stage — what matters is that it does not error on config resolution.

---

## Step 7 — Web runtime dependencies

```bash
cd $REPO
pnpm --filter @revive/web add @supabase/supabase-js @tanstack/react-query react-router-dom
pnpm --filter @revive/web add @revive/core
```

You are not building routes in this task — but for when you get there, §9 is **two** routes, `/queue` and `/leads/:id`. A `/settings` route appears in older drafts of the contract and was cut on review; the voice-profile demo it existed for now runs as an eval fixture instead (task 8 seeds a second agent, task 12 prints the two drafts side by side). Don't scaffold it.

Create `apps/web/src/lib/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Copy .env.local.example to .env.local and fill in the values from `supabase start`.",
  )
}

export const supabase = createClient(url, anonKey)
```

Note there is no service-role key and no `ANTHROPIC_API_KEY` here. Per §2, the LLM key never reaches the client — all LLM calls happen in edge functions.

### Verify

```bash
cd $REPO && pnpm --filter @revive/web build
```

Succeeds. (`supabase.ts` isn't imported by anything yet, so the missing-env throw won't fire.)

---

## Step 8 — Supabase local

Step 0 must be green first. `docker ps` has to work.

```bash
cd $REPO
supabase init
```

If it asks about generating VS Code settings for Deno, **yes** is convenient — you'll be writing Deno edge functions from task 9.

```bash
supabase start
```

First run pulls several GB of container images. Expect 3–10 minutes. Subsequent starts take seconds.

When it finishes it prints a block like:

```
         API URL: http://127.0.0.1:54321
     GraphQL URL: http://127.0.0.1:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
        anon key: eyJhbGciOi...
service_role key: eyJhbGciOi...
```

Create `.env.local` from the example and fill in the two client values:

```bash
cd $REPO
cp .env.local.example .env.local
```

Edit `.env.local`:

- `VITE_SUPABASE_URL` ← the **API URL**
- `VITE_SUPABASE_ANON_KEY` ← the **anon key**
- `ANTHROPIC_API_KEY` ← your key, or leave blank for now (nothing calls it until task 9)

`.env.local` is gitignored. Never commit it.

If you lose the output, `supabase status` reprints it.

### Verify

```bash
cd $REPO && supabase status
```

All services report running. Open **http://127.0.0.1:54323** in a browser — the Studio dashboard loads. No tables yet; task 2 creates them.

---

## Step 9 — `pnpm dev` renders

Replace `apps/web/src/App.tsx` with something that exercises Tailwind and shadcn at once:

```tsx
import { Button } from "@/components/ui/button"

export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50">
      <h1 className="text-2xl font-semibold text-neutral-900">Revive</h1>
      <p className="text-sm text-neutral-500">Scaffold OK</p>
      <Button>Test button</Button>
    </div>
  )
}
```

Make sure `App.tsx` no longer imports `./App.css` (deleted in step 3).

```bash
cd $REPO && pnpm dev
```

### Verify

Open the URL Vite prints (usually http://localhost:5173). You should see:

- Centred content on a light grey background → **Tailwind is working**
- A styled dark button with rounded corners and a hover state → **shadcn is working**
- Clean browser console, no errors → **the `@` alias resolves**

If the page is unstyled black-on-white, Tailwind isn't loading — recheck step 3, particularly that `index.css` contains `@import "tailwindcss";` and that `main.tsx` still imports `./index.css`.

Stop the dev server with `Ctrl+C`.

---

## Step 10 — Acceptance and commit

### Checklist

- [ ] `docker ps` works inside WSL
- [ ] `pnpm install` clean at root
- [ ] `pnpm -r list --depth -1` shows all four `@revive/*` packages
- [ ] `pnpm dev` renders a Tailwind-styled page with a working shadcn button
- [ ] `pnpm test` exits 0
- [ ] `pnpm --filter @revive/web build` succeeds
- [ ] `supabase status` shows services running; Studio loads at :54323
- [ ] No `tailwind.config.js`, no `postcss.config.js`, no `packages/ui`
- [ ] `packages/core/package.json` has no `dependencies` key
- [ ] `.env.local` exists with real values and is **not** staged for commit

### Expected tree

Only the paths task 1 owns. Anything from §1 not listed here belongs to a later task.

```
$REPO/
├── package.json
├── pnpm-workspace.yaml
├── vitest.config.ts
├── .gitignore
├── .env.local.example
├── .env.local              # gitignored
├── issue.md
├── planning-overview.md
├── README.md
├── apps/
│   └── web/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── tsconfig.app.json
│       ├── components.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── index.css
│           ├── lib/
│           │   ├── supabase.ts
│           │   └── utils.ts
│           └── components/ui/button.tsx
├── packages/
│   ├── core/{package.json,tsconfig.json,src/index.ts}
│   ├── llm/{package.json,tsconfig.json,src/index.ts}
│   └── eval/{package.json,tsconfig.json,src/run.ts,fixtures/}
└── supabase/
    └── config.toml
```

### Commit

Contract rule 6: commit after each numbered task with the task number in the message.

```bash
cd $REPO
git status          # confirm .env.local is NOT listed
git add -A
git commit -m "Task 1: scaffold pnpm workspace, Vite web app, Tailwind + shadcn, local Supabase"
```

---

## Next

Task 2 — write `supabase/migrations/0001_init.sql` and `0002_rls.sql` exactly as `planning-overview.md` §3, run the migration, then confirm both:

- RLS is enabled on all six tenant tables
- the partial unique index `drafts_one_pending_per_lead` exists

§3 is longer than the table list suggests: `drafts` also carries a `run_id` column, and §8 specifies an `approve_draft` Postgres function that ships as a migration too. Copy §3 literally — do not summarize it.