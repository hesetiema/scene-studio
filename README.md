# scene-studio

Embeddable 3D scene editor SDK monorepo. Ships as npm package `@scenio/scene-editor` (placeholder scope — TBD before first public publish). Current line: `0.5.0`.

## What this is

A web component (`<scene-editor>`) plus a headless core that together give any host page a 3D editor: load a JSON scene document, orbit/zoom, click-select, transform with gizmos, undo/redo, host-driven save with structured conflicts, and glTF animation playback. WebGL2 by default; WebGPU via a documented opt-in seam. Prefer to bring your own UI? `createSceneEditor()` gives you the full editing logic — state, history, selection, plugins, typed events — with zero DOM.

- **Consumers:** see [`packages/scene-editor/README.md`](packages/scene-editor/README.md) for install/usage and [`packages/scene-editor/API.md`](packages/scene-editor/API.md) for the full API surface.
- **Design rationale (D1–D22):** internal design doc, not yet published; shipped feature specs live in [`docs/specs/`](docs/specs/).

## Layout

```
packages/scene-editor/   the npm package (core + element + three adapter)
apps/playground/         interactive demo + Playwright visual/perf baselines
e2e/                     Playwright configs & specs (critical flows, studio tools, visual, perf)
scripts/                 pack-smoke (npm pack consumer test)
```

### Playground

`apps/playground` is the reference host: model loading (GLB/GLTF/OBJ/STL, including multi-file `.gltf` bundles), shading modes (studio / X-Ray / wireframe / normal / clay), skeleton overlay, explode preview, lighting & backdrop presets, exposure/tone mapping, camera presets + turntable, glTF animation transport, gizmo tool switching, snapshot and GLB/OBJ export. Google-style viewer architecture: a single viewer store (`src/viewer/viewer-state.ts`) fans out to `ViewerController.update*()`, and each HUD panel only patches state.

- `?scene=default` loads the deterministic `box-1 / box-2 / gem-1` fixture the e2e suites assert on; the bare URL boots the mecha showcase.
- `?select=<id>` selects an object and (optionally) applies `&move=x,y,z&rot=x,y,z&scale=x,y,z` for reproducible screenshots.
- Host wiring lives in `src/main.ts` (runtime factory, save/conflict store, boot); view state lives in `src/viewer/`; HUD chrome is composed from `src/ui/panels/` by `src/ui/studio-shell.ts`.

## Develop

Requires Node 24+, pnpm 11+.

```bash
pnpm install
pnpm typecheck           # tsc across packages that define the script
pnpm test                # vitest unit tests (per package)
pnpm build               # vite build + .d.ts for every package
```

### E2E & quality gates

```bash
pnpm test:e2e            # critical flows (auto-starts dev server unless one is up)
pnpm test:e2e:visual     # screenshot regression (chromium)
pnpm test:perf           # first-interactive + p95 frame-time gate (D10)
pnpm test:pack           # npm pack → fresh consumer install/typecheck/build
```

CI (`.github/workflows/ci.yml`) runs unit tests on a `three` version matrix (`0.186.0` pinned + `latest`), e2e critical flows, the perf gate with relaxed thresholds, and the pack smoke. A red `latest` leg on a new three minor is the intended early warning for the peer range (D14).

### Playwright notes

- Config: `e2e/playwright.config.ts`. Projects: `chromium` (critical + visual) and `perf` (depends on chromium, runs alone to avoid frame-time contention).
- Local runs reuse an already-serving dev server on port 4173; CI starts its own.
- Visual baselines live under `e2e/visual/__screenshots__/`.

## Versioning & release

- Every completed phase bumps the minor (`0.x.0`) and tags it; the first stable release is `1.0.0` once the public API is locked.
- Publish flow: see TODOS.md; the npm scope is still undecided (`@scenio` is a placeholder).
- `npm pack` must stay green (`pnpm test:pack`) — it is the release gate for consumer-facing package contents.

## Status

`0.5.0` alpha. Not yet published to npm. API may still shift before `1.0.0`; after that, semver applies.

Known roadmap items (TODOS.md): HDR environment maps, embedded-camera switching, morph-target UI.
