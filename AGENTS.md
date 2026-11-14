# AGENTS.md

> 简体中文: [AGENTS.zh-CN.md](AGENTS.zh-CN.md)

Guidance for AI coding agents in this repo. This file is deliberately narrow: it holds only the
things you can break **silently** — layering rules, invariants, and gotchas where "looks fine, tests
pass" is still wrong.

**Process rules are not in this file.** Read-only vs write separation, irreversible-action approval,
risk grading (L0–L3), the evidence format, investigation and review protocols live in the repo wiki,
[AI 开发规则（Agent 必读）](https://github.com/hesetiema/scene-studio/wiki/AI-%E5%BC%80%E5%8F%91%E8%A7%84%E5%88%99%EF%BC%88Agent-%E5%BF%85%E8%AF%BB%EF%BC%89).
On conflict that document wins — it ranks itself above `AGENTS.md` in its §0 precedence order, and it
delegates repo-specific facts to this file.

Everything else lives in the human docs, don't duplicate it:

| Doc | Lang | Read it for |
|---|---|---|
| [README.md](README.md) | EN | What the product is, the two usage shapes, the gate table |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 中文 | Layers, 21 design decisions with trade-offs, measured benchmarks, known limits |
| [TODOS.md](TODOS.md) | 中文 | What's done, what's left, **explicit non-goals (§5)** |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | EN | Every public symbol |
| [apps/playground/README.md](apps/playground/README.md) | EN | Reference host, module map, local data prep |

## What this repo is

One document model, one runtime contract, three shapes:

- **viewer** — `<scene-editor src="model.glb">`, attributes only, no authoring chrome
- **editor** — `<scene-editor>` + `loadDocument(doc)`: selection, gizmo, commands, undo/redo
- **headless** — `createSceneEditor({ runtime })`, zero DOM

A viewer is **not** a second code path: it synthesizes a one-object document (`createSrcDocument()`)
and drives the same load/select/history pipeline. The difference is one field, `mode`.

`packages/scene-editor` is the published SDK. `apps/playground` is a consumer — it imports **only**
through the package name (`@scenio/scene-editor{,/element,/three,/bim}`, wired in
`apps/playground/tsconfig.json` → `paths`). Never reach into `../../packages/.../src` from the app;
that seam is what makes the package boundary real.

## Commands

Node 24+, pnpm 11+. Run from the repo root.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Typecheck all | `pnpm typecheck` |
| Unit tests (vitest) | `pnpm test` |
| Single suite | `pnpm --filter @scenio/scene-editor test test/core/document-schema.test.ts` |
| Build all | `pnpm build` |
| E2E | `pnpm test:e2e` |
| Visual regression | `pnpm test:e2e:visual` |
| Perf gate | `pnpm test:perf` |
| Release metadata | `pnpm test:release` |
| Tarball consumption | `pnpm test:pack` |
| Playground dev | `pnpm --filter @scenio/playground dev` → <http://127.0.0.1:3000> |

Before calling work done, run `pnpm typecheck && pnpm test`. Touch `package.json` exports, docs or
version → also `pnpm test:release`. Touch the build or the public surface → also `pnpm test:pack`.

If pnpm aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, the checkout's `node_modules`
predates the lockfile — it wants to purge and rebuild. In a non-interactive shell, skip pnpm's dep
check and call the binary directly (`packages/scene-editor/node_modules/.bin/vitest run <file>`);
don't hand-delete `node_modules` to get past it.

## Invariants

Breaking one of these is a regression, not a refactor. Where a check exists, it's named.

1. **Layer direction is one-way.** `core` ← `runtime` ← {`element`, `three`}. Measured today:
   **75 files, 227 static internal edges, 0 cycles** — keep the cycle count at 0. The one remaining
   backwards edge is a *type-only* `import type { Transform }` from
   `core/commands/transform-command.ts` → `runtime/runtime-contract.ts`; `Transform` is a
   document-level concept and ideally belongs in `core`.
2. **`core/` and `runtime/` must not import `three`.** The unit suite runs in vitest
   `environment: "node"` with `FakeRuntime`, no GPU and no DOM — a `three` import in `core` breaks
   the whole suite. That failure *is* the alarm, so don't "fix" it by adding a DOM environment.
3. **`three` gets imported statically in exactly three places:** `src/three/*` (the adapter),
   `src/assets/*` (decoder assembly + glTF loader), `src/bim/*` (FBX/Revit loading). It is a
   **peer** dependency, externalized in `vite.config.ts` — never bundle it, never add it to
   `core`/`runtime`. `element/` sits right at the edge: it must reach three only through a lazy
   `import()` (see `lazyGltfLoader()`), never a static `import … from`, so the element entry does not
   pull three at module scope. 18 such lazy addon edges exist today and are sanctioned.
   > `docs/ARCHITECTURE.md` §2 still claims "three imports only appear under `src/three/`". That
   > sentence is stale: 7 files under `assets/` (3) and `bim/` (4) import three statically today.
   > Rule 3 above is the accurate one; fix the doc rather than the code when you touch it.
4. **`RuntimeContract` is the only rendering seam.** New runtime capability → new **optional**
   member on the interface (plus a fallback in `FakeRuntime`). A required member breaks every
   custom runtime and every test at once.
5. **Display state never enters the document.** Tone mapping, exposure, shadows, `display-mode`,
   `explode`, camera-orbit are preview state; only `view` (camera / lights / environment) persists.
   `view` is at **schema v3** — adding a field means schema bump + migration in
   `core/document/migrations.ts` + fixture rewrite. Don't do it to ship a viewer feature.
6. **The SDK performs no host I/O.** Save is `save-request` → host `PUT` → `markSaved(revision)`.
   A revision mismatch surfaces a structured conflict; the SDK never auto-merges.
7. **`src` is read once, at connect.** Changing it later is a deliberate no-op (one `console.warn`).
   This was removed on purpose — see TODOS.md §1, "动态 `src` 能力已移除". Do not restore it.
8. **The package ships no CSS and no stylesheet export.** The element is an unstyled custom
   element; sizing is the host's job. Don't reintroduce `:host` rules — the element uses light DOM.
9. **One package, four entries** (`.`, `./element`, `./three`, `./bim`). No package split, no plugin
   panel slots, no CRDT — all three are explicit non-goals in TODOS.md §5.

## Adding a public export subpath — four places, all required

1. `packages/scene-editor/package.json` → `exports` (`types` + `import`)
2. `packages/scene-editor/vite.config.ts` → `build.lib.entry`
3. `apps/playground/tsconfig.json` → `compilerOptions.paths`
4. `scripts/pack-smoke.mjs` → `required` array — needs `dist/<name>.js` **and** the `.d.ts` path as
   `tsc` actually emits it. `tsc` preserves the `src/` directory structure, vite flattens the JS
   filename: `src/bim/bim-entry.ts` → `dist/bim-entry.js` + `dist/bim/bim-entry.d.ts`.

Miss #4 and `test:pack` fails only in CI; miss #3 and the playground typecheck resolves against
stale `dist`.

## Where new code goes

| If you're writing… | It goes in | Notes |
|---|---|---|
| Document shape, migration, validation | `core/document/` | Pure data. No DOM, no three |
| An edit operation | `core/commands/` | One file per command; implement `mergeWith` or the slider drags fill the undo stack |
| Events, error codes | `core/events/` | Error codes are a closed set — adding one is a public API change |
| State machine, selection, plugin host | `runtime/` | Zero DOM, zero three; must work against `FakeRuntime` |
| A new runtime capability | `runtime/runtime-contract.ts` **+** `runtime/fake-runtime.ts` **+** `three/three-runtime.ts` | Both implementations or neither |
| Asset loading, decoder assembly | `assets/` | |
| Anything three.js: rigs, picking, export | `three/` | One `*-rig.ts` per concern in `three/viewer/` |
| DOM attributes, slots, lifecycle, a11y | `element/` | One 3 106-line class plus three small helpers (`register`, `src-document`, `download`); see "Known weak points" |
| Host UI, panels, URL params | `apps/playground/src/` | Never a reason to touch the SDK |

## Conventions

- **TypeScript is strict and fussy.** `noUncheckedIndexedAccess` (indexing yields `T | undefined`),
  `exactOptionalPropertyTypes` (no assigning `undefined` to an optional key), `verbatimModuleSyntax`
  (type-only imports **must** say `import type`).
- **Language:** identifiers, code comments, commit messages are **English** (601 English comment
  lines vs 3 Chinese in `src/`). `docs/ARCHITECTURE.md` and `TODOS.md` are Chinese. User-facing
  docs ship in pairs (`.md` / `.zh-CN.md`).
- **Commits:** `type(scope): subject` — `feat(viewer): …`, `fix(bim): …`, `docs(element): …`,
  `refactor: …`. Present in the log; match it.
- **Unit tests:** vitest, `test/**/*.test.ts`, node environment, no DOM. Assert the public contract,
  not private `#methods`. Element behaviour is exercised through happy-dom + the public API.
- **E2E:** Playwright. **Use `127.0.0.1`, never `localhost`** — the dev server binds IPv4 only.
- **Visual baselines:** canvas-only, SwiftShader, 1% tolerance. Refresh with
  `pnpm test:e2e:visual --update-snapshots` and commit the PNGs.
- **`@scenio` is a placeholder scope.** Don't publish; version bumps go through `test:release`.

## Traps that have already cost time

- **Never commit data snapshots.** `apps/playground/public/data/` and `public/bim/` are gitignored
  on purpose — they are real customer geometry with internal identifiers (building/floor IDs). The
  demo renders a "no local data" card without them; that is the correct state for a fresh clone.
- **Don't add a second render path for viewer features.** If a feature needs to look different in
  viewer mode, it belongs behind `mode` / `interactive: false`, not behind a new `if (isViewer)`.
- **`instancing` and picking interact.** Batched proxies are moved to layer 1 (`BATCH_PROXY_LAYER`,
  exported from `three/viewer/instancing-rig.ts`), which the main camera does not render — so any
  full-scene raycast must `layers.enableAll()`. `picker.ts` does exactly this; copy it, don't
  hand-roll a `Raycaster`.
- **`markDirty` must walk the subtree.** Dragging a group has to reach batched children, or the
  batch lags behind its parents.
- **`setExplode(0)` must short-circuit.** Re-asserting the attribute on load used to trigger a full
  baseline rebuild and doubled first-frame time.
- **Don't add `material.needsUpdate` sweeps** for tone mapping — three r186+ already keys its
  program cache on `toneMapping`.

## Known weak points (known, accepted — don't "improve" them unasked)

- `element/scene-editor-element.ts` is **3 106 lines**, one class, ~60 public + ~50 private members.
  It is one aggregation on purpose: attribute parsing, slot lifecycle, error overlay, decoder
  assembly, load orchestration, mode projection. It is also the least unit-testable file in the repo.
  Connect-time assembly is already split into seven named stages — `#mountCanvas` → `#createRuntime`
  → `#pushInitialState` → `#wireInput` → `#wireViewport` → `#forwardFacadeEvents` → `#publishReady`.
  **Put new wiring in the stage it belongs to; never grow `#init` back into a 269-line method.**
  `#forwardFacadeEvents` is one flat table on purpose — don't split it for a line count.
  The next real step is extracting `slot-chrome` (455 lines, 27 private fields, zero cross-cluster
  state) and `viewer-attributes` (422 lines, 10 fields); that is a project, not a drive-by refactor.
  Do **not** extract the load pipeline (139 lines but 17 cross-cluster fields) or the façade forwards.
- `three/three-runtime.ts` is **1 524 lines** of wiring + lifecycle + forwarding, with no section
  markers, sitting on top of `three/viewer/`'s 20 single-concern modules (9 `*-rig.ts`: animation,
  camera, display, environment, explode, gizmo, instancing, lighting, morph; plus picking-adjacent
  pieces like `object-store`, `render-loop`, `framing`, `shared-resources`). Second-most-likely
  split target.
- `src/bim/` (770 lines: Revit floor loading, FBX, outline mesh, unit conversion) is
  domain-specific loading code for one product living inside a general-purpose SDK, exposed as a
  public `./bim` entry with exactly one consumer (`apps/playground/src/vent-demo.ts`). Acceptable
  under "no package split", but it is the first thing that would move out.
- **No import-boundary check is wired into the repo.** Invariants 1–3 are enforced by discipline and
  by the node-environment unit suite, nothing else — a `three` import added to `core/` passes
  `pnpm typecheck` and only fails as a confusing test-environment error. A ~150-line checker exists
  outside the repo (it walks `src/`, resolves static vs lazy vs type-only specifiers, and reports
  B1/B2/B3 violations); promoting it to `scripts/` and a CI step is the cheapest quality win
  available. That change touches CI, so it is L3 — ask first.

## When in doubt

Ask before changing a public type, the document schema, or an invariant above. Everything else —
internal refactors, tests, docs, playground UI — just do it and run the gates.
