# @scenio/scene-editor

Embeddable 3D scene editor SDK for the web. Drop a `<scene-editor>` element into any page, load a JSON scene document, and get orbit/zoom, click-to-select, transform gizmos, undo/redo, and host-driven save/conflict flow — all headless-testable behind a runtime contract.

**Status:** `0.5.0` — API surface is locked for the v0.1 line but may still adjust before `1.0.0`. `three` is a peer dependency you install yourself.

> Package scope (`@scenio`) is a placeholder until the npm org name is chosen — see TODOS.md.

## Install

```bash
npm install @scenio/scene-editor three
# or
pnpm add @scenio/scene-editor three
```

Peer dependency: `three@^0.186.0` (see [Compatibility](#compatibility)).

## Quick start

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // idempotent, SSR-safe (no top-level side effects)

  const el = document.querySelector("scene-editor");
  await el.ready; // resolves on init; failures also arrive as the `error` event

  await el.loadDocument({
    schemaVersion: 2,
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
      environment: { background: null, gridVisible: true },
    },
  });
</script>

<scene-editor style="width: 640px; height: 400px"></scene-editor>
```

In this page you can orbit (drag), zoom (wheel), click an object to select it (`Shift`/`Ctrl`/`Cmd`+click toggles into a multi-selection), drag the transform gizmo, and press `Ctrl+Z` / `Ctrl+Shift+Z` for undo/redo (only when focus is inside the element).

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

Selection is a one-class subsystem: `select` sets, `add`/`remove` compose, `toggle` flips — all emit `selection-change`. Plugins use the same `install(context)` contract as the element. Events: `selection-change`, `history-change`, `document-dirty`, `save-request`, `error`.

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
```

Internally the runtime is a thin orchestrator over the rigs exported from this entry: `createCameraRig`, `createLightingRig`, `createEnvironmentRig`, `createObjectStore`, `createGizmoRig`, `createAnimationRig`, `createRenderLoop`. Use them directly if you need a viewer-shaped runtime without the editor contract.

## Document model

A scene is plain JSON validated with zod (`SceneDocumentSchema`). Nothing GPU-specific is persisted — camera, lights and environment are plain fields (`view`, D22), GPU resources are not.

```ts
type SceneDocument = {
  schemaVersion: 2; // positive int literal; currently 2 (v1 is migrated on load)
  sceneId: string;
  revision: number; // nonnegative int; host-authoritative
  objects: SceneObjectDTO[];
  view: {
    camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
    lights: {
      ambient: { color: "#rrggbb"; intensity: number };
      directional: { color: "#rrggbb"; intensity: number; position: [number, number, number] };
    };
    environment: { background: "#rrggbb" | null; gridVisible: boolean };
  };
};

type SceneObjectDTO = {
  id: string;
  type: "mesh" | "group";
  name: string;
  assetId?: string; // loads via AssetCache / AssetResolver (glTF)
  parentId?: string;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ, radians (D3)
  scale: [number, number, number];
  metadata?: Record<string, unknown>;
};
```

Parse and validate yourself with `parseSceneDocument(input)` / `SceneDocumentSchema` when you need the same errors on the server.

**View state (D22).** v1 documents load unchanged — a generic migration registry fills the engine defaults for `view`. The documented view is applied to the viewport only when the loaded document's `sceneId` changes (so a reload restores the same scene instead of snapping the camera). A camera/lights/environment change marks the document dirty but is **not** undoable — view edits are a separate dirty channel from commands. The facade `view-change` event carries `source: "interaction" | "api" | "load"` so hosts can tell a user gesture from a programmatic `setViewState()` or a scene switch. Live truth is always `getViewState()`; the document holds the last *recorded* view.

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
el.applyRemote(serverDoc, { baseRevision: el.revision }); // inbound update (D17)
el.applyTransform(id, from, to); // one undoable command
el.undo(); el.redo();
el.requestSave();                // dispatches `save-request` with the document
el.markSaved(serverRevision);    // host confirmed save → adopts revision, clears dirty
el.use(plugin); el.unuse(id);   // plugins (see below)
el.dirty; el.revision; el.selectedIds;
const live = el.getViewState();     // live viewport view (D22)
el.setViewState(view);           // record + apply a view; dirty, never undoable (D22)
```

### Events (all `CustomEvent`s)

| Event | Detail | Fired when |
|---|---|---|
| `scene-ready` | — | Init finished; canvas + runtime live |
| `selection-change` | `{ ids: string[] }` | Selection changed (click, API, clear) |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | Command executed / undo / redo |
| `document-dirty` | `{ dirty: boolean }` | Dirty flag crossed false↔true |
| `save-request` | `{ reason, document, revision }` | Host should persist (manual `requestSave()` today) |
| `view-change` | `{ view, source: "interaction" \| "api" \| "load" }` | Viewport view changed (D22) |
| `error` | `{ code, message, cause? }` | Any SDK failure — the reliable failure channel |

Keyboard shortcuts captured while focus is inside the element: `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, and `G`/`R`/`S` (reserved tool modes, currently swallowed) — exported as `CAPTURED_COMBOS`.

### Save & conflict flow

The SDK never talks to your backend. Persistence is host-driven (D17/D18):

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
| `three` | `^0.186.0` (peer) | CI matrix pins `0.186.0` and `latest` within the range (D14) |
| Renderer | WebGL2 (default), WebGPU via `rendererFactory` | WebGL2 is CI-tested; WebGPU is opt-in, host-owned |
| Formats | `.glb`, `.gltf` | Unit tests + e2e; Draco/KTX2 optional inject |
| Browsers | Any browser with WebGL2 + ES modules | Playwright e2e (Chromium in CI); other engines best-effort |
| Module | ESM only (`"type": "module"`) | `npm pack` consumption test (`pnpm test:pack`) |
| SSR | Element is lazy — `defineSceneEditor()` at runtime, never at import | Core entry has no DOM side effects |

When `three@0.187` lands, the CI `latest` leg goes red on purpose — that is the early-warning system for the peer range, not a broken build.

## Adopt vs. build (D21)

What this SDK deliberately reuses vs. owns — so nobody rebuilds the same wheel:

| Concern | Choice | Notes |
|---|---|---|
| Transform gizmo | **Adopt** three `TransformControls` | Wrapped in `three/` adapter layer; drag → one command |
| Orbit / pan / zoom | **Adopt** three `OrbitControls` | Wrapped; injected via factory seam |
| Picking | **Adopt** three `Raycaster` | `createPicker()`; BVH optional later |
| glTF load/export | **Adopt** three `GLTFLoader` | Exporter not wired in v0.1 |
| Schema validation | **Adopt** zod | `SceneDocumentSchema` |
| SceneDocument, command history, element contract | **Build** | The product core |
| Caching, lifecycle, conflict rules | **Build** | Refcount cache, disposers, host-driven D17 |
| three addon integration | **Build** (adapter layer) | All three imports live under `three/` (D14) |

## Development (monorepo)

This package lives in a pnpm workspace. From the repo root:

```bash
pnpm install
pnpm typecheck          # all packages
pnpm test               # vitest unit tests
pnpm build              # dist for every package
pnpm test:e2e           # Playwright critical flows (dev server auto-managed)
pnpm test:perf          # frame-time + first-interactive gate (D10)
pnpm test:pack          # npm pack → fresh consumer install smoke
```

Playground app: `apps/playground` (full editor + visual baselines).

## License

TBD (set before first public publish).
