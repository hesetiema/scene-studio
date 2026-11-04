# scene-studio

Embeddable 3D scene editor SDK monorepo. Published to npm as `@scenio/scene-editor` (the scope is still a placeholder). This repo tracks `0.5.0`; the latest published version is `0.3.0`.

## What this is

A web component (`<scene-editor>`) plus a headless core that together give any host page a 3D editor: load a JSON scene document, orbit/zoom, click-select, transform with gizmos, undo/redo, host-driven save with structured conflicts, and glTF animation playback. WebGL2 by default; WebGPU via a documented opt-in seam. Prefer to bring your own UI? `createSceneEditor()` gives you the full editing logic — state, history, selection, plugins, typed events — with zero DOM.

- **Consumers:** see [`packages/scene-editor/README.md`](packages/scene-editor/README.md) for install/usage and [`packages/scene-editor/API.md`](packages/scene-editor/API.md) for the full API surface.
- **Design rationale (D1–D22):** internal design doc, not yet published; shipped feature specs live in [`docs/specs/`](docs/specs/).

## Layout

```
packages/scene-editor/   the npm package (core + element + three adapter)
apps/playground/         interactive demo, focused SDK demos (/demos), visual/perf baselines
e2e/                     Playwright configs & specs (critical flows, SDK coverage, studio tools, visual, perf)
scripts/                 pack-smoke (npm pack consumer test)
```

### Playground

`apps/playground` is the reference host: model loading (GLB/GLTF/OBJ/STL, including multi-file `.gltf` bundles), shading modes (studio / X-Ray / wireframe / normal / clay), skeleton overlay, explode preview, analytic lights + IBL (intensity slider) & backdrop presets, exposure/tone mapping, camera presets + turntable, glTF animation transport, gizmo tool switching, snapshot and GLB/OBJ export. Google-style viewer architecture: a single viewer store (`src/viewer/viewer-state.ts`) fans out to `ViewerController.update*()`, and each HUD panel only patches state.

Focused SDK demos live under `/demos/` (one API surface per page: host editing API, document model, headless facade, assets) and are asserted by `e2e/sdk-coverage.spec.ts`; `minimal.html` is the smallest end-to-end integration.

- `?scene=default` loads the deterministic `box-1 / box-2 / gem-1` fixture the e2e suites assert on; the bare URL boots a minimal home screen (drag-and-drop target + sample links), and `?model=<id>` jumps straight to a Khronos sample.
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
pnpm test:e2e            # full suite: critical + visual + perf
pnpm test:e2e:visual     # visual regression only (SwiftShader, canvas-only)
pnpm test:perf           # first-interactive + p95 frame-time gate (D10)
pnpm test:release        # package/README/LICENSE/repository consistency
pnpm test:pack           # npm pack → fresh consumer install/typecheck/build
```

CI (`.github/workflows/ci.yml`) runs unit tests on a `three` version matrix (`0.186.0` pinned + `latest`), e2e critical flows, the visual regression gate (canvas-only screenshots under SwiftShader), the perf gate with relaxed thresholds, the release-metadata check, and the pack smoke. A red `latest` leg on a new three minor is the intended early warning for the peer range (D14).

### Playwright notes

- Config: `e2e/playwright.config.ts`. Projects: `chromium` (critical), `visual` (software-rendered screenshots, CI-gated), and `perf` (depends on chromium, runs alone to avoid frame-time contention).
- Local runs reuse an already-serving dev server on port 4173; CI starts its own.
- Visual baselines live under `e2e/visual/__screenshots__/visual/`. They are canvas-only captures rendered with SwiftShader, so they do not depend on the host GPU or fonts. Refresh with `pnpm test:e2e:visual --update-snapshots` and commit the PNGs.

## Versioning & release

- Every completed phase bumps the minor (`0.x.0`) and tags it; the first stable release is `1.0.0` once the public API is locked.
- Publish flow: `.github/workflows/publish.yml` publishes when a `0.*` tag matching the package version is pushed (`next` for prereleases, `latest` for stable). The npm scope is still undecided (`@scenio` is a placeholder).
- `pnpm test:release` checks that package metadata, README version/status, LICENSE, and the repository URL stay in sync. It runs in CI.
- `npm pack` must stay green (`pnpm test:pack`) — it is the release gate for consumer-facing package contents.

## Status

`0.5.0` alpha in this repo. The latest published version is `0.3.0`; `0.4.0`/`0.5.0` have not been released yet. API may still shift before `1.0.0`; after that, semver applies.

Known roadmap items (TODOS.md): HDR environment maps, embedded-camera switching, morph-target UI.

## License

MIT — see [LICENSE](LICENSE).
