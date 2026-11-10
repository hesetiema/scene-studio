# @scenio/scene-editor

Embeddable 3D scene editor SDK for the web. Drop a `<scene-editor>` element into any page, load a JSON scene document, and get orbit/zoom, click-to-select, transform gizmos, undo/redo, and host-driven save/conflict flow — all headless-testable behind a runtime contract.

**Status:** `0.7.0` alpha (unreleased); npm `latest` is `0.6.0`. The API may still adjust before `1.0.0`; after that, semver applies. `three` is a peer dependency you install yourself.

> Package scope (`@scenio`) is a placeholder until the npm org name is chosen — see TODOS.md.

Repository: <https://github.com/hesetiema/scene-studio> · Issues: <https://github.com/hesetiema/scene-studio/issues>

**Docs:** English (this page) · [简体中文](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.zh-CN.md) · [API reference](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/API.md) · [Project overview](https://github.com/hesetiema/scene-studio/blob/main/README.zh-CN.md)

**Editing scope:** transforms, view state, object create/delete/reparent, procedural geometry (`primitive`) and material overrides — all undoable. Object duplication, multi-object transform, morph targets and HDR environments are not in the document API yet.

## Install

```bash
npm install @scenio/scene-editor three
# or
pnpm add @scenio/scene-editor three
```

Peer dependency: `three@^0.186.0` (see [Compatibility](#compatibility)).

> This README tracks the repo (`0.7.0`); npm `latest` is `0.6.0`. To try the unreleased work, build from source (`pnpm install && pnpm build`) and pack `packages/scene-editor`.

## Quick start

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // idempotent, SSR-safe (no top-level side effects)

  const el = document.querySelector("scene-editor");
  await el.ready; // resolves on init; failures also arrive as the `error` event

  await el.loadDocument({
    schemaVersion: 3,
    sceneId: "demo",
    revision: 0,
    objects: [
      {
        id: "box-1",
        type: "mesh",
        name: "Box",
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    view: {
      camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.55 },
        directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
      },
      environment: { background: null, gridVisible: true, iblIntensity: 1 },
    },
  });
</script>

<scene-editor style="width: 640px; height: 400px"></scene-editor>
```

In this page you can orbit (drag), zoom (wheel), click an object to select it (`Shift`/`Ctrl`/`Cmd`+click toggles into a multi-selection), drag the transform gizmo, and press `Ctrl+Z` / `Ctrl+Shift+Z` for undo/redo (only when focus is inside the element).

## Preview a glTF in one line

If all you need is to show a model, skip the document entirely:

```html
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>
```

The element synthesizes a one-mesh document, auto-frames the camera, and reports lifecycle through `progress` → `load` (`load.detail.url` carries the source). Previews default to ACES tone mapping — set `tone-mapping="none"` to opt out, and call `frameModel()` to re-fit after a layout change. An explicit `loadDocument()` still wins until `src` changes.

A preview is a **viewer**, not an editor: no floor grid, model-viewer framing (`camera-orbit="0deg 75deg"`, `field-of-view="auto"` → 30° landscape / 45° portrait), and the environment map as the only light source. `environment-image="neutral"` (the default here) uses a grayscale softbox studio; `environment-image="room"` switches to the editor's warm `RoomEnvironment`.

```ts
el.addEventListener("progress", ({ detail }) => setBar(detail.totalProgress));
el.addEventListener("load", ({ detail }) => console.log("ready", detail.url));
el.addEventListener("error", ({ detail }) => showError(detail.code));
```

Viewer chrome is attribute-only and never written to the document — the canvas is transparent by default, so the page shows through a `null` background:

```html
<scene-editor
  src="/models/robot.glb"
  loading="lazy"
  auto-rotate
  rotation-per-second="20"
  min-camera-orbit="auto 60deg 2m"
  max-camera-orbit="auto 100deg 12m"
  autoplay
  animation-name="Idle"
  animation-crossfade-duration="300"
  pause-at-end
></scene-editor>
```

Declarative slots cover the viewer chrome, model-viewer style:

```html
<scene-editor src="/models/robot.glb" reveal="interaction">
  <img slot="poster" src="/poster.jpg" alt="Loading" />
  <div slot="progress-bar">Loading…</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4">Lens</button>
</scene-editor>
```

`reveal` mirrors model-viewer: `auto` (the default) drops the poster on `load`, `interaction` on the first gesture, `manual` only through `dismissPoster()`; `poster-dismissed` fires once per dismissal. Capture/export parity: `getDimensions()`, `positionAndNormalFromPoint()`, `toDataURL()`, `toBlob()`, `exportScene()`.

## Headless usage

No DOM, no canvas, no CustomEvent — bring your own UI (and, if you want pixels, your own runtime):

```ts
import { createSceneEditor } from "@scenio/scene-editor";
import { FakeRuntime } from "@scenio/scene-editor"; // tests; production: ThreeRuntime or your own

const editor = createSceneEditor({ runtime: new FakeRuntime() }); // runtime is required

await editor.loadDocument(doc);
editor.select(["box-1"]);
editor.applyTransform("box-1", from, to); // one undoable command
editor.undo();

editor.on("save-request", ({ document, revision }) => {
  // your transport — the SDK never talks to your backend
  fetch("/api/scene", { method: "PUT", body: JSON.stringify(document) })
    .then((r) => r.json())
    .then(({ revision }) => editor.markSaved(revision));
});

editor.requestSave();
```

**Bring your own undoable actions** — `executeCommand` is a first-class entry, not an escape hatch. Any state change with `execute`/`undo` joins the same history as gizmo drags:

```ts
editor.executeCommand({
  label: "host:rename",
  execute: () => doRename("new name"),
  undo: () => doRename("old name"),
});
```

**Bring your own input** — forward keys yourself; `handleKeyDown` returns `true` when it consumed the event (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y`, reserved `G`/`R`/`S`):

```ts
window.addEventListener("keydown", (e) => {
  if (editor.handleKeyDown(e)) e.preventDefault();
});
```

Selection is a one-class subsystem: `select` sets, `add`/`remove` compose, `toggle` flips — all emit `selection-change`. Plugins use the same `install(context)` contract as the element. Events: `selection-change`, `history-change`, `document-dirty`, `save-request`, `view-change`, `view-changing` (opt-in), `error`.

Mental model if you know the PlayCanvas Editor API: our `history` / `selection` / document+runtime ≈ their `editor.api.globals.history` / `selection` / `entities` — same separation of logic from UI.

## Entry points

| Import | What you get | When to use |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` custom element + `defineSceneEditor()` | Most integrations — recommended |
| `@scenio/scene-editor` | Core: `createSceneEditor()` headless facade, schema, commands, controller, errors, assets, plugin types | Headless editing, custom runtimes, server-side validation |
| `@scenio/scene-editor/three` | `ThreeRuntime`, composable viewer rigs (camera / lighting / environment / objects / gizmo / animation / render loop), picker, controls bindings, example plugin | Advanced: custom renderer, custom scene graph wiring |
| `@scenio/scene-editor/style.css` | Minimal editor chrome styles | Pair with the element entry |

The element creates its canvas and a default `ThreeRuntime` (WebGL2) for you. Override `SceneEditorElement.runtimeFactory` before the element connects if you need a custom runtime (assets, WebGPU, tests).

`ThreeRuntime` also exposes `setTransformMode("translate" | "rotate" | "scale")` (and a `transformMode` getter) so a host toolbar can switch the gizmo; the call is accepted before the TransformControls addon finishes loading.

**Animation.** glTF clips are forwarded by `AssetCache` loaders (`LoadedAsset.animations`) and bound to each mounted asset instance:

```ts
runtime.animations;                       // [{ id: "obj-1#0", objectId, index, name, duration }]
runtime.playAnimation("obj-1", 0);        // starts the clip and the render loop
runtime.pauseAnimations();
runtime.resumeAnimations();               // continue without rewinding
runtime.setAnimationSpeed(1.5);
runtime.setAnimationTime(0.8);            // scrub (seconds)
runtime.setAnimationOptions({ autoplay: true, clipName: "Idle", crossfadeSeconds: 0.3, pauseAtEnd: true });
runtime.setCameraControls({ pan: false, zoom: true, limits: { radius: [2, 20] } }); // theta/phi in degrees
runtime.setAutoRotate({ enabled: true, degreesPerSecond: 20, delayMs: 3000 });
```

Internally the runtime is a thin orchestrator over the rigs exported from this entry: `createCameraRig`, `createLightingRig`, `createEnvironmentRig`, `createObjectStore`, `createGizmoRig`, `createAnimationRig`, `createRenderLoop`. Use them directly if you need a viewer-shaped runtime without the editor contract.

## Document model

A scene is plain JSON validated with zod (`SceneDocumentSchema`). Nothing GPU-specific is persisted — camera, lights and environment are plain fields (`view`), GPU resources are not.

```ts
type SceneDocument = {
  schemaVersion: 3; // positive int literal; currently 3 (v1/v2 are migrated on load)
  sceneId: string;
  revision: number; // nonnegative int; host-authoritative
  objects: SceneObjectDTO[];
  view: {
    camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
    lights: {
      ambient: { color: "#rrggbb"; intensity: number };
      directional: { color: "#rrggbb"; intensity: number; position: [number, number, number] };
      additional?: ( // omitted = no extra lights
        | { kind: "directional"; color: string; intensity: number; position: [number, number, number]; target?: [number, number, number] }
        | { kind: "point"; color: string; intensity: number; position: [number, number, number]; distance?: number; decay?: number }
        | { kind: "spot"; color: string; intensity: number; position: [number, number, number]; target?: [number, number, number]; angle?: number; penumbra?: number; distance?: number; decay?: number }
        | { kind: "hemisphere"; skyColor: string; groundColor: string; intensity: number }
      )[];
    };
    environment: {
      background: "#rrggbb" | null;
      gridVisible: boolean;
      iblIntensity?: number; // image-based lighting strength; 0 = analytic lights only (default 1)
    };
  };
};

type SceneObjectDTO = {
  id: string;
  type: "mesh" | "group" | "primitive";
  name: string;
  assetId?: string; // mesh only: loads via AssetCache / AssetResolver (glTF)
  parentId?: string; // builds real three.js parenting
  geometry?: PrimitiveGeometry; // primitive only, required
  material?: { // per-object override; only the fields you set are written
    color?: "#rrggbb";
    roughness?: number; // 0..1
    metalness?: number; // 0..1
    emissive?: "#rrggbb";
    emissiveIntensity?: number;
    opacity?: number; // < 1 implies transparent
    flatShading?: boolean;
    wireframe?: boolean;
  };
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ, radians
  scale: [number, number, number];
  metadata?: Record<string, unknown>;
};

// geometry.kind: box | sphere | cylinder | cone | torus | plane | capsule | icosahedron
// Every geometry parameter is optional (the factory applies its documented default);
// unknown parameters are rejected, never silently ignored.
```

Parse and validate yourself with `parseSceneDocument(input)` / `SceneDocumentSchema` when you need the same errors on the server.

**Migrations.** v1 and v2 documents load unchanged — a generic migration registry walks them to the current `schemaVersion`. v3 only *added optional fields* (`primitive`, `geometry`, `material`, `view.lights.additional`), so a migrated v2 payload is byte-identical to the input apart from the version stamp. `onMigrate` reports every step, oldest first.

**View state.** The documented view is applied to the viewport only when the loaded document's `sceneId` changes (so a reload restores the same scene instead of snapping the camera). A camera/lights/environment change marks the document dirty but is **not** undoable — view edits are a separate dirty channel from commands. The facade `view-change` event carries `source: "interaction" | "api" | "load"` so hosts can tell a user gesture from a programmatic `setViewState()` or a scene switch. Live truth is always `getViewState()`; the document holds the last *recorded* view.

**Hierarchy, geometry and materials.** `parentId` builds real three.js parenting: the child is added to its parent object instead of the scene root, so a group's transform composes down the tree. A child whose parent failed to load is promoted to a root rather than dropped, and a parent cycle is broken instead of mounted. `type: "primitive"` renders procedural geometry (`box`, `sphere`, `cylinder`, `cone`, `torus`, `plane`, `capsule`, `icosahedron`) with per-kind parameters. `material` writes only the fields present: a colour-only override on a GLB keeps the asset's own roughness, and each instance gets a **cloned** material so repainting one object never leaks into the shared cache copy or into other instances of the same asset.

**Object commands.** `addObject` / `removeObject` / `reparent` / `setMaterial` are the write side of the same model, and all four go through `CommandHistory`. `addObject` is async — the document is never given an object whose asset failed to load. `removeObject` cascades the whole subtree and records each original index, so undo restores the array order rather than appending. `reparent` and the rest re-run `validateHierarchy`, so duplicate ids, missing parents, self-parenting and cycles are rejected at edit time instead of at the next load. `setMaterial(id, undefined)` clears the override and puts the asset's own materials back.

Consecutive writes to the same object **merge** (`Command.mergeWith`): a material slider drag spends one undo step, whose `from` is the value before the drag — otherwise a single gesture would consume the whole history.

**Image-based lighting.** `environment.iblIntensity` drives a PMREM-prefiltered built-in studio environment (`RoomEnvironment` — no network assets, no decoder). `0` turns it off and leaves the analytic ambient/directional lights as the only illumination; the key is optional and defaults to `1`, so v2 documents written before IBL still load and simply pick up the default. WebGPU renderers and GPU-less test runtimes skip IBL silently (`scene.environment` stays `null`). Metals and glass depend on it: with analytic lights alone they render nearly black.

## Element API

```ts
const el = document.querySelector("scene-editor") as SceneEditorElement;

await el.ready;                 // init done (or rejected — also see `error` event)
await el.controlsReady;         // gizmo mounted (resolves immediately for non-three runtimes)
await el.loadDocument(doc);     // zod-validated, serialized; clears history + selection
const snapshot = el.getDocument(); // deep clone; never the save trigger
el.selectObject("box-1");
el.select(["box-1", "box-2"]);   // multi-select set
el.addToSelection(["gem-1"]);    // compose: add / remove / toggle
el.toggleSelection("box-2");
el.applyRemote(serverDoc, { baseRevision: el.revision }); // inbound update
el.applyTransform(id, from, to); // one undoable command
el.undo(); el.redo();
el.requestSave();                // dispatches `save-request` with the document
el.markSaved(serverRevision);    // host confirmed save → adopts revision, clears dirty
el.use(plugin); el.unuse(id);   // plugins (see below)
el.dirty; el.revision; el.selectedIds;
const live = el.getViewState();     // live viewport view
el.setViewState(view);           // record + apply a view; dirty, never undoable
```

### Events (all `CustomEvent`s, dispatched on the element; none bubble or compose)

| Event | Detail | Fired when |
|---|---|---|
| `scene-ready` | — | Init finished; canvas + runtime live (element-only) |
| `progress` | `{ totalProgress, reason }` | Load progress, monotonic 0..1 |
| `load` | `{ sceneId, url }` | Document mounted and renderable |
| `selection-change` | `{ ids: string[] }` | Selection changed (click, API, clear) |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | Command executed / undo / redo |
| `document-dirty` | `{ dirty: boolean }` | Dirty flag crossed false↔true |
| `save-request` | `{ reason, document, revision }` | Host should persist (manual `requestSave()` today) |
| `view-change` | `{ view, source: "interaction" \| "api" \| "load" }` | Settled viewport view |
| `view-changing` | `{ view }` | In-flight camera sample — opt in with `live-view-events`, high frequency |
| `camera-change` | `{ position, target, fov }` | Camera moved (drag, damping, auto-rotate); always on, camera-only |
| `environment-change` | `{ environment, source }` | Background / grid / IBL / HDR / contact shadow changed |
| `visibility-change` | `{ visible: boolean }` | Element entered/left the viewport (element-only) |
| `model-visibility` | `{ visible: boolean }` | model-viewer's verdict: loaded × in-viewport × poster dismissed (element-only) |
| `play` / `pause` | `{ objectId, index, name }` / — | A clip started or resumed / playback stopped from a playing state |
| `loop` / `finished` | `{ count, name }` / `{ objectId, name }` | The clip wrapped (`count` starts at 1) / a one-shot clip ended |
| `error` | `{ code, message, cause? }` | Any SDK failure — the reliable failure channel |

`view-changing` exists for live consumers (remote camera sync, recording, a HUD); persist on `view-change` instead. `visibility-change` needs no plumbing on hosts without `IntersectionObserver`, and `SceneEditorElement.visibilityObserverFactory = () => null` disables it. `model-visibility` is the composite verdict, so it also moves when a poster appears or is dismissed — read `el.modelIsVisible` / `el.loaded` for the current state. Full contract + versioning rules: [API.md](API.md#element-events-customevent).

Keyboard shortcuts captured while focus is inside the element: `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, and `G`/`R`/`S` (reserved tool modes, currently swallowed) — exported as `CAPTURED_COMBOS`.

### Save & conflict flow

The SDK never talks to your backend. Persistence is host-driven:

1. User edits → `dirty: true` → your UI enables Save.
2. You call `el.requestSave()` (or react to `save-request`) → PUT `el.getDocument()` to your API.
3. On success: `el.markSaved(nextRevision)` — dirty clears, revision adopts the server value.
4. On revision mismatch: your server rejects; you surface a structured conflict (`base` / `incoming` / `local` documents) and let the user resolve. The SDK never auto-merges. `EditorController.applyRemote()` enforces the same rule for inbound updates.

## Assets

Objects can reference assets by `assetId`. The SDK resolves and caches them; you own the URLs and transport:

```ts
import { AssetCache } from "@scenio/scene-editor";
import { createResolverAssetLoader } from "@scenio/scene-editor"; // or via element

// Element path — simplest:
el.assetResolver = {
  async resolve(assetId) {
    return `/api/assets/${assetId}.glb`; // or a full URL / signed URL
  },
};
// Set before connect. Element wires AssetCache + GLTFLoader (lazy) for you.

// Programmatic path:
const cache = new AssetCache(async (assetId) => {
  /* return { scene, dispose? } */
});
SceneEditorElement.runtimeFactory = (canvas) =>
  new ThreeRuntime({ canvas, assetCache: cache });
```

Formats: `glb` and `gltf` only (`SUPPORTED_ASSET_FORMATS`). Draco/KTX2 are optional enhancers you inject into the glTF loader — the SDK does not bundle them.

`AssetCache` refcounts per `assetId`: parallel loads collapse, dispose runs when the last reference drops, next retain reloads.

The resolver is the host's trust boundary — documents carry `assetId`, not URLs. Allowlist ids (`Record<string, string>`) instead of interpolating `assetId` into a path, so a hand-edited document cannot point the page at arbitrary URLs.

## Errors

All SDK failures are typed. Element failures arrive on the `error` event; direct API calls may also throw. Runtime and asset failures are forwarded verbatim, so `asset-unsupported-format` / `asset-not-found` reach the host instead of collapsing into a generic load failure.

**`SceneErrorCode`** (element/controller): `validation` · `asset-resolve-failed` · `asset-load-failed` · `render-init-failed` · `lifecycle` · `conflict`

**`AssetErrorCode`** (asset layer): `asset-not-found` · `asset-resolve-failed` · `asset-load-failed` · `asset-unsupported-format` · `asset-disposed`

```ts
el.addEventListener("error", (e) => {
  const { code, message } = (e as CustomEvent).detail;
  // code is a stable string — switch on it, don't parse messages
});
```

## Plugins

Plugins are plain objects with an `install(context)` function — no framework, no lifecycle registry:

```ts
import type { SceneEditorPlugin } from "@scenio/scene-editor";

const logger: SceneEditorPlugin = {
  id: "logger",
  install({ editor, on, addDisposer }) {
    const off = on("selection-change", ({ ids }) => console.log("selected", ids));
    addDisposer(off);
    // or return an uninstall fn from install()
  },
};

el.use(logger);
el.unuse("logger");
```

Context: `runtime` (RuntimeContract — events + methods, no THREE internals), `editor` (load/get/select/transform/undo/redo/save surface), `on(type, handler)`, `addDisposer(fn)`. Duplicate ids throw; `use()` before connect is queued and installed after init.

## WebGPU (opt-in)

Default renderer is WebGL2 (`createRenderer`). WebGPU is viable via the documented `rendererFactory` seam:

```ts
import { ThreeRuntime } from "@scenio/scene-editor/three";
import { WebGPURenderer } from "three/webgpu";

SceneEditorElement.runtimeFactory = async (canvas) => {
  const renderer = new WebGPURenderer({ canvas });
  await renderer.init(); // MUST await — the runtime renders on construction
  return new ThreeRuntime({ canvas, rendererFactory: () => renderer });
};

// Detect silent WebGL fallback:
// renderer.backend.isWebGPUBackend === true
```

WebGL2 remains the default and the CI-tested path; the seam is the only supported WebGPU integration point (no probe/demo app ships).

## Compatibility

| Axis | Supported | How verified |
|---|---|---|
| `three` | `^0.186.0` (peer) | CI matrix pins `0.186.0` and `latest` within the range |
| Renderer | WebGL2 (default), WebGPU via `rendererFactory` | WebGL2 is CI-tested; WebGPU is opt-in, host-owned |
| Formats | `.glb`, `.gltf` | Unit tests + e2e; Draco/KTX2 optional inject |
| Browsers | Any browser with WebGL2 + ES modules | Playwright e2e (Chromium in CI; visual baselines under SwiftShader); other engines best-effort |
| Module | ESM only (`"type": "module"`) | `npm pack` consumption test (`pnpm test:pack`) |
| SSR | Element is lazy — `defineSceneEditor()` at runtime, never at import | Core entry has no DOM side effects |

When `three@0.187` lands, the CI `latest` leg goes red on purpose — that is the early-warning system for the peer range, not a broken build.

## Adopt vs. build

What this SDK deliberately reuses vs. owns — so nobody rebuilds the same wheel:

| Concern | Choice | Notes |
|---|---|---|
| Transform gizmo | **Adopt** three `TransformControls` | Wrapped in `three/` adapter layer; drag → one command |
| Orbit / pan / zoom | **Adopt** three `OrbitControls` | Wrapped; injected via factory seam |
| Picking | **Adopt** three `Raycaster` | `createPicker()`; BVH optional later |
| glTF load/export | **Adopt** three `GLTFLoader` | Exporter not wired in v0.1 |
| Schema validation | **Adopt** zod | `SceneDocumentSchema` |
| SceneDocument, command history, element contract | **Build** | The product core |
| Caching, lifecycle, conflict rules | **Build** | Refcount cache, disposers, host-driven save/conflict flow |
| three addon integration | **Build** (adapter layer) | All three imports live under `three/` |

## Development (monorepo)

This package lives in a pnpm workspace. From the repo root:

```bash
pnpm install
pnpm typecheck          # all packages
pnpm test               # vitest unit tests
pnpm test:release       # package/README/LICENSE/repository consistency
pnpm build              # dist for every package
pnpm test:e2e           # Playwright suite (critical + visual + perf)
pnpm test:e2e:visual    # visual regression only (SwiftShader, canvas-only)
pnpm test:perf          # frame-time + first-interactive gate
pnpm test:pack          # npm pack → fresh consumer install smoke
```

Playground app: `apps/playground` (full editor + visual baselines).

## License

MIT — see [LICENSE](LICENSE).
