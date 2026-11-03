# Playground

Reference host for `@scenio/scene-editor`: a full-screen viewport with the chrome a
real integration needs. Not published — it exists to exercise the SDK and to back
the Playwright visual/perf baselines.

```bash
pnpm --filter @scenio/playground dev      # http://127.0.0.1:3000
pnpm --filter @scenio/playground typecheck
```

## Module map

| Path | Responsibility |
|---|---|
| `src/main.ts` | Composition root: runtime factory, document boot, host save/conflict store, `window.__*` e2e hooks |
| `src/bootstrap.ts` | Deterministic scene documents (`mechaAssemblyDoc`, `defaultMultiDoc`, single-model presets) |
| `src/assets/model-loader.ts` | Asset registry, lazy GLTF/Draco/Meshopt loading, custom-file → `SceneDocument` |
| `src/camera/camera-controller.ts` | Frame / preset / turntable. Preview frames go through `runtime.applyViewState()`; the document is written once per gesture |
| `src/ui/studio-shell.ts` | Toolbar, gizmo tool, presets, drag & drop, hotkeys, snapshot/export wiring |
| `src/ui/view-mode-controller.ts` | Studio / X-Ray / wireframe / normal / clay shading; owns and disposes its material overrides |
| `src/ui/explode-controller.ts` | Component-explode preview (runtime-only offsets, document positions stay the baseline) |
| `src/ui/scene-presets.ts` | Lighting, backdrop and grid presets — all persisted through `view` (D22) |
| `src/ui/scene-export.ts` | GLB / OBJ export from document transforms + PNG snapshot |
| `src/ui/hud-controller.ts` | Telemetry panel, selection inspector, dirty state, toasts, FPS meter |
| `src/interaction/hotkeys.ts` | Declarative single-key shortcuts (modifier combos belong to the element, D20) |

Additional entries: `webgpu.html` (WebGPU rendererFactory seam), `perf.html` (D10 bench).

## URL parameters

| Parameter | Effect |
|---|---|
| *(none)* | Mecha showcase scene |
| `?scene=default` | Deterministic `box-1 / box-2 / gem-1` fixture used by e2e |
| `?select=<id>` | Load the fixture and select an object |
| `&move=x,y,z` `&rot=x,y,z` `&scale=x,y,z` | Apply one undoable transform (screenshot fixtures) |

## Design notes

- **View state is persisted, previews are not.** Camera flight, turntable and explode
  render through runtime-only paths; a single `setViewState()` commits when the
  gesture ends. This keeps `view-change` / dirty events at human granularity instead
  of 60 per second.
- **Shading overrides are owned.** `ViewModeController` caches the original material
  per mesh, tracks generated materials and disposes them on mode change, and only
  traverses document objects (never the grid, lights or gizmo helper).
- **Export uses the document, not the viewport.** Objects are cloned with their stored
  transforms, so an exploded preview or an in-flight drag never leaks into the file.
