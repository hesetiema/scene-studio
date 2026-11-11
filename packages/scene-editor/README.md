# @scenio/scene-editor

Embeddable 3D scene editor and model viewer for the web: drop `<scene-editor>` into any page and get
a glTF preview or a fully editable scene — orbit/zoom, click-to-select, transform gizmos, undo/redo,
and a host-owned save/conflict flow — all headless-testable behind a small runtime contract.

**Status:** `0.7.0` alpha (unreleased); npm `latest` is `0.6.0`. The API may still adjust before
`1.0.0`; after that, semver applies. `three` is a peer dependency you install yourself.

> Package scope (`@scenio`) is a placeholder until the npm org name is chosen — see TODOS.md.

Repository: <https://github.com/hesetiema/scene-studio> · Issues: <https://github.com/hesetiema/scene-studio/issues>

**Docs:** English (this page) · [简体中文](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.zh-CN.md) · [API reference](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/API.md) · [Architecture & benchmarks](https://github.com/hesetiema/scene-studio/blob/main/docs/ARCHITECTURE.md)

## Install

```bash
npm install @scenio/scene-editor three
# or
pnpm add @scenio/scene-editor three
```

Peer dependency: `three@^0.186.0` (see [Compatibility](#compatibility)).

## Entry points

| Import | What you get | When to use |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` + `defineSceneEditor()` | Most integrations — viewer **and** editor |
| `@scenio/scene-editor` | `createSceneEditor()`, schema, commands, errors, assets, plugin types | Headless editing, custom runtimes, server-side validation |
| `@scenio/scene-editor/three` | `ThreeRuntime` + composable viewer rigs, picker, control bindings | Custom renderer or custom scene-graph wiring |
| `@scenio/scene-editor/style.css` | Minimal editor chrome styles | Pair with the element entry |

The element creates its canvas and a default `ThreeRuntime` (WebGL2) for you. Override
`SceneEditorElement.runtimeFactory` before the element connects if you need a custom runtime.

## Viewer mode

The shortest path from a glTF URL to a rendered model. No document, no editor chrome:

```html
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>
```

The element synthesizes a one-mesh document, frames the camera the way `<model-viewer>` does, and
reports lifecycle through `progress` → `load` → `error`. A preview is a **viewer**: no floor grid,
`field-of-view="auto"` (30° landscape / 45° portrait), the environment map as the only light
source, and **no authoring chrome** — no transform gizmo, no click-to-select, no editor keystrokes.
An explicit `loadDocument()` takes over until `src` changes again, and flips the same element to
editor mode; `mode="viewer"` keeps a host document read-only.

```ts
el.addEventListener("progress", ({ detail }) => setBar(detail.totalProgress));
el.addEventListener("load", ({ detail }) => console.log("ready", detail.url));
el.addEventListener("error", ({ detail }) => showError(detail.code));
```

Viewer chrome is **attribute-only and never written to the document**. Canvas is transparent by
default, so a `null` background shows the page through.

| Group | Attributes |
|---|---|
| Mode | `mode` (`viewer` \| `editor`) — absent means derived: `src` preview → viewer, `loadDocument()` → editor. The effective value is mirrored to `data-mode` |
| Loading | `src`, `loading="lazy"`, `with-credentials`, `reveal` (`auto`/`interaction`/`manual`), `seamless-poster` |
| Camera | `camera-orbit`, `camera-target`, `field-of-view`, `min-field-of-view`, `max-field-of-view`, `min-camera-orbit`, `max-camera-orbit`, `camera-damping`, `interpolation-decay` |
| Rotation | `auto-rotate`, `rotation-per-second`, `auto-rotate-delay` |
| Input | `disable-pan`, `disable-zoom`, `disable-tap`, `orbit-sensitivity`, `zoom-sensitivity`, `pan-sensitivity`, `touch-action` |
| Look | `tone-mapping` (`none`/`linear`/`aces`/`agx`/`neutral`), `exposure`, `display-mode` (`studio`/`xray`/`wireframe`/`normal`/`clay`), `explode` (`0..1`, component explode), `environment-image` (`neutral`/`room`/`legacy` or HDR/EXR/URL), `skybox-image`, `shadow-intensity`, `shadow-softness` |
| Content | `variant-name`, `camera-name`, `animation-name`, `animation-crossfade-duration`, `autoplay`, `pause-at-end` |
| A11y | `alt` (mirrored to the canvas `aria-label`; falls back to `3D model: <file>`) |

Previews default to `tone-mapping="neutral"` (what model-viewer's `auto` resolves to on glTF) and
`environment-image="neutral"`; documents keep the engine default unless the host sets one.

Viewport overlays are attribute-only and never touch the document: `display-mode="xray"` swaps every
rendered mesh (batched `InstancedMesh` chunks included) to one shared override material —
`"studio"` restores the originals exactly; `explode="0.3"` offsets objects from their stored
positions, so `0` restores exactly and neither ever reaches an `exportDocument()` file.

Light-DOM slots cover the viewer chrome — same names as model-viewer:

```html
<scene-editor src="/models/robot.glb" reveal="interaction">
  <img slot="poster" src="/poster.jpg" alt="Loading" />
  <div slot="progress-bar">Loading…</div>
  <div slot="error">Could not load the model</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">Lens</button>
</scene-editor>
```

Without a `slot="error"` child the element paints its own message over the canvas, so a dead
WebGL context or a 404 is never a blank rectangle.

Capture/export parity: `getDimensions()`, `positionAndNormalFromPoint()`, `queryHotspot()`,
`toDataURL()`, `toBlob()`, `exportScene()`, `frameModel()`, `dismissPoster()`; document-level export
and file download are covered in ["Upload / export / snapshot"](#upload--export--snapshot). Playback transport:
`availableAnimations` / `animationName` / `paused` / `currentTime` / `timeScale` /
`play()` / `pause()` plus `setCameraByName()` and `setMorphInfluence()`.

## Editor mode

Editing is document-driven: you load a validated JSON scene, the element renders and edits it, and
`save-request` tells you when to persist.

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // idempotent, SSR-safe (no top-level side effects)

  const el = document.querySelector("scene-editor");
  await el.ready; // resolves on init; failures also arrive as the `error` event

  // The envelope can be built for you too: createSceneDocument / createDocumentFromAsset, see "Upload / export / snapshot"
  await el.loadDocument({
    schemaVersion: 3,
    sceneId: "demo",
    revision: 0,
    objects: [
      { id: "box-1", type: "mesh", name: "Box", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
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

Drag to orbit, wheel to zoom, click to select (`Shift`/`Ctrl`/`Cmd`+click toggles multi-select),
drag the gizmo to transform, `Ctrl+Z` / `Ctrl+Shift+Z` while focus is inside the element. All of that
is editor-only: `mode="viewer"` on the same document gives a read-only viewport (orbit and zoom, no
axes, no selection), which is how a saved scene is shown without an editor around it.

```ts
await el.ready;                     // init done
await el.controlsReady;             // gizmo mounted
const snapshot = el.getDocument();  // deep clone; never a save trigger
el.select(["box-1", "box-2"]);      // set semantics; add/remove/toggle compose
el.applyTransform(id, from, to);    // one undoable command
el.addObject(dto); el.removeObject(id); el.reparent(id, parentId); el.setMaterial(id, material);
el.undo(); el.redo(); el.requestSave(); el.markSaved(serverRevision);
el.applyRemote(serverDoc, { baseRevision: el.revision }); // fast-forward or structured conflict
const live = el.getViewState(); el.setViewState(view);    // dirty, never undoable
```

### Events

All are `CustomEvent`s on the element; none bubble or compose.

| Event | Detail | Fired when |
|---|---|---|
| `scene-ready` | — | Init finished; canvas + runtime live |
| `progress` | `{ totalProgress, reason }` | Load progress, monotonic 0..1 |
| `load` | `{ sceneId, url }` | Content mounted and renderable |
| `selection-change` | `{ ids }` | Selection changed |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | Command executed / undo / redo |
| `document-dirty` | `{ dirty }` | Dirty flag crossed false↔true |
| `save-request` | `{ reason, document, revision }` | Host should persist |
| `view-change` | `{ view, source }` | Settled viewport view (`interaction`/`api`/`load`) |
| `view-changing` | `{ view }` | In-flight camera sample — opt in with `live-view-events` |
| `camera-change` | `{ position, target, fov }` | Camera moved (drag, damping, auto-rotate); always on |
| `environment-change` | `{ environment, source }` | Background / grid / IBL / HDR / shadow changed |
| `model-visibility` | `{ visible }` | `loaded × in-viewport × poster dismissed` |
| `visibility-change` | `{ visible }` | Element entered/left the viewport |
| `play` / `pause` / `loop` / `finished` | transport payloads | Clip started, stopped, wrapped, one-shot ended |
| `error` | `{ code, message, cause? }` | Any SDK failure — the reliable failure channel |

Persist on `view-change`; `view-changing` is for live consumers (remote camera sync, recording, HUD).
`SceneEditorElement.visibilityObserverFactory = () => null` disables viewport observation.

### Save & conflict

The SDK never talks to your backend:

1. User edits → `dirty: true` → your UI enables Save.
2. You call `el.requestSave()` (or react to `save-request`) → PUT `el.getDocument()` to your API.
3. On success: `el.markSaved(nextRevision)` — dirty clears, revision adopts the server value.
4. On revision mismatch your server rejects; you surface a structured conflict (`base` / `incoming` /
   `local`) and let the user resolve. The SDK never auto-merges.

## Headless

No DOM, no canvas — bring your own UI (and your own runtime if you want pixels):

```ts
import { createSceneEditor, FakeRuntime } from "@scenio/scene-editor";

const editor = createSceneEditor({ runtime: new FakeRuntime() }); // runtime is required

await editor.loadDocument(doc);
editor.select(["box-1"]);
editor.applyTransform("box-1", from, to); // one undoable command
editor.undo();
editor.on("save-request", ({ document }) => persist(document));
editor.requestSave();

// Host-defined undoable actions join the same history
editor.executeCommand({
  label: "host:rename",
  execute: () => doRename("new name"),
  undo: () => doRename("old name"),
});

// Bring your own input: returns true when the event was consumed
window.addEventListener("keydown", (e) => {
  if (editor.handleKeyDown(e)) e.preventDefault();
});
```

## Document model

A scene is plain JSON validated with zod; nothing GPU-specific is persisted.

```ts
type SceneDocument = {
  schemaVersion: 3;   // v1/v2 are migrated on load
  sceneId: string;
  revision: number;   // host-authoritative
  objects: SceneObjectDTO[];
  view: {
    camera: { position: Vec3; target: Vec3; fov: number };
    lights: {
      ambient: { color: string; intensity: number };
      directional: { color: string; intensity: number; position: Vec3 };
      additional?: ( // point | spot | directional | hemisphere
        { kind: "point"; color: string; intensity: number; position: Vec3; distance?: number; decay?: number }
        /* … */
      )[];
    };
    environment: { background: string | null; gridVisible: boolean; iblIntensity?: number };
  };
};

type SceneObjectDTO = {
  id: string;
  type: "mesh" | "group" | "primitive";
  name: string;
  assetId?: string;              // mesh only: resolved through AssetCache
  parentId?: string;             // real three.js parenting
  geometry?: PrimitiveGeometry;  // primitive only (box | sphere | cylinder | cone | torus | plane | capsule | icosahedron)
  material?: {                   // only the fields you set are written
    color?: string; roughness?: number; metalness?: number;
    emissive?: string; emissiveIntensity?: number; opacity?: number;
    flatShading?: boolean; wireframe?: boolean;
  };
  position: Vec3; rotation: Vec3 /* Euler XYZ, radians */; scale: Vec3;
  metadata?: Record<string, unknown>;
};
```

- **Migrations.** A registry walks v1/v2 to the current version; v3 only *added optional fields*, so a
  migrated v2 payload is byte-identical apart from the version stamp.
- **Hierarchy.** `parentId` builds real parenting (a group composes down the tree). A child whose
  parent failed to load is promoted to a root; a cycle is broken instead of mounted.
- **Materials** are cloned per instance, so repainting one object never leaks into the shared cache or
  into other instances of the same asset.
- **View state** is applied only when the loaded document's `sceneId` changes; a camera/lights/
  environment edit marks the document dirty but is **not** undoable.
- **Commands.** `addObject` / `removeObject` / `reparent` / `setMaterial` all go through
  `CommandHistory` and the same `validateHierarchy` used on load, so duplicate ids, missing parents,
  self-parenting and cycles are rejected at edit time. Consecutive writes to one object merge
  (`Command.mergeWith`), so a slider drag costs one undo step.
- **IBL.** `environment.iblIntensity` drives a PMREM-prefiltered built-in studio (`RoomEnvironment`,
  no network assets). `0` leaves the analytic lights alone; WebGPU and GPU-less runtimes skip it.

Parse and validate yourself with `parseSceneDocument(input)` / `SceneDocumentSchema` when you need the
same errors on a server.

## Assets

Objects reference assets by `assetId`; you own the URLs and the transport.

```ts
el.assetResolver = {
  async resolve(assetId) {
    return `/api/assets/${assetId}.glb`; // or a full/signed URL
  },
};
// Set before connect. The element wires AssetCache + a lazy GLTFLoader for you.
```

Formats: `glb` and `gltf` (`SUPPORTED_ASSET_FORMATS`). Compressed glTF works out of the box — point
`decoder-path` at three's payload layout (`<base>/draco/gltf` + `<base>/basis`) or just add
`decoder-cdn`, and Draco / KTX2 / Meshopt are assembled lazily on the first load. Nothing is fetched
until then, and a host assigning `el.dracoLoader` / `el.ktx2Loader` / `el.meshoptDecoder` still wins
for that format. `AssetCache` refcounts per `assetId`: parallel loads collapse, dispose runs when the
last reference drops.

The resolver is your trust boundary — documents carry `assetId`, not URLs. Allowlist ids instead of
interpolating them into a path.

## Upload / export / snapshot

The "upload → edit → export" loop needs no host-side boilerplate:

```ts
import { defineSceneEditor, downloadBlob } from "@scenio/scene-editor/element";
import { createSceneDocument, createDocumentFromAsset } from "@scenio/scene-editor";

// 1) Build documents (six-field envelope, `view` merged over defaults as a ViewPatch, objects cloned)
const doc = createSceneDocument({
  objects: [{ id: "box-1", name: "Box", position: [0, 0.5, 0] }],
  view: { camera: { position: [6, 5, 10] } },
});
const single = createDocumentFromAsset({ assetId: "robot", name: "Robot" });

// 2) Load local files (.gltf sidecars get rewritten to blob: URLs; progress / framing / error reuse the src path)
await el.loadFiles([file]); // File | File[] | FileList

// 3) Export (document transforms by default — preview offsets / material previews never leak; obj is a separate dynamic chunk)
const blob = await el.exportDocument({ format: "glb" }); // "glb" | "gltf" | "obj"
downloadBlob(blob, "scene.glb");

// 4) Snapshot
downloadBlob(await el.toBlob("image/png"), "shot.png");
```

- `loadFiles` mints a unique asset id per upload (`upload-<n>-<name>`); a host `assetResolver` still wins — only ids that are not the element's own reach the host table.
- `exportDocument({ from: "live" })` exports what is on screen (`glb` / `gltf` only); the default is `from: "document"`.
- `downloadBlob` returns the filename actually used (timestamped when empty), so a toast can show it.
- Reference lighting looks ship as data: `LIGHTING_PRESETS` (`studio` / `cyber` / `sunset` / `contrast`, typed against `view.lights`) from the core entry — apply through your own `setViewState`, or define your own table with the same shape.

## Errors

All SDK failures are typed; element failures arrive on the `error` event, direct calls may also throw.
Asset errors are forwarded verbatim instead of collapsing into a generic load failure.

- **`SceneErrorCode`**: `validation` · `asset-resolve-failed` · `asset-load-failed` ·
  `render-init-failed` · `lifecycle` · `conflict`
- **`AssetErrorCode`**: `asset-not-found` · `asset-resolve-failed` · `asset-load-failed` ·
  `asset-unsupported-format` · `asset-disposed`

Switch on `code`, never on messages.

## Plugins

Plain objects with an `install(context)` function — no framework, no lifecycle registry:

```ts
const logger: SceneEditorPlugin = {
  id: "logger",
  install({ editor, on, addDisposer }) {
    addDisposer(on("selection-change", ({ ids }) => console.log("selected", ids)));
  },
};
el.use(logger);
el.unuse("logger");
```

Context: `runtime` (`RuntimeContract` — no THREE internals), `editor`, `on(type, handler)`,
`addDisposer(fn)`. Duplicate ids throw; `use()` before connect is queued.

## WebGPU (opt-in)

Default renderer is WebGL2. WebGPU goes through the documented `rendererFactory` seam:

```ts
import { WebGPURenderer } from "three/webgpu";

SceneEditorElement.runtimeFactory = async (canvas) => {
  const renderer = new WebGPURenderer({ canvas });
  await renderer.init(); // MUST await — the runtime renders on construction
  return new ThreeRuntime({ canvas, rendererFactory: () => renderer });
};
// renderer.backend.isWebGPUBackend === true detects a silent WebGL fallback
```

## Compatibility

| Axis | Supported | How verified |
|---|---|---|
| `three` | `^0.186.0` (peer) | CI matrix pins `0.186.0` + `latest` within the range |
| Renderer | WebGL2 (default), WebGPU via `rendererFactory` | WebGL2 CI-tested; WebGPU opt-in, host-owned |
| Formats | `.glb`, `.gltf` | Unit tests + e2e; Draco/KTX2 optional inject |
| Browsers | Anything with WebGL2 + ES modules | Playwright e2e (Chromium in CI) |
| Module | ESM only | `npm pack` consumption test |
| SSR | Element is lazy — `defineSceneEditor()` at runtime | Core entry has no DOM side effects |

When `three@0.187` lands, the CI `latest` leg goes red on purpose — that is the early-warning system
for the peer range, not a broken build.

## Adopt vs. build

| Concern | Choice | Notes |
|---|---|---|
| Transform gizmo / orbit / picking | **Adopt** three addons | Wrapped in `three/`; drag → one command |
| glTF load/export | **Adopt** three `GLTFLoader` | Draco/KTX2/Meshopt injectable |
| Schema validation | **Adopt** zod | `SceneDocumentSchema` |
| SceneDocument, history, element contract, cache/lifecycle | **Build** | The product core |
| Draw-call batching for repeated primitives | **Build** | `InstancedMesh` chunks (≤256 instances each) per (geometry parameters, material) pair, bucketed by world position so frustum culling still works; object identity, picking, export and undo are untouched. `instancing="false"` / `instancing: false` opts out, live |
| Placeholder resource sharing | **Build** | Refcounted pool for placeholder geometries and the base material — 5 000 placeholders hold 11.0 MB of JS heap instead of 26.5 MB. A host-supplied pool survives `dispose()` |
| Static merge inside one asset | **Build** | Same-material, same-layout leaf meshes of an asset bake into one `BufferGeometry` (200 boxes → 1 mesh, ~25–31 ms); assets with clips or `KHR_materials_variants` are skipped entirely, and `restore()` puts the originals back |
| BVH-accelerated picking | **Adopt** `three-mesh-bvh` | Patched per-mesh (never `Mesh.prototype`) above 2 000 triangles, imported on demand so it lands in its own chunk: 130 560 triangles go from 12.0 ms to 0.10 ms per pick |
| Multi-clip blending | **Build** | One mixer per object, several weighted actions per mixer — real blending, not two mixers fighting. `playAnimationBlend()` / `animationBlend` |

## Development (monorepo)

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e          # Playwright: critical + visual + perf
pnpm test:release      # metadata consistency
pnpm test:pack         # npm pack → fresh consumer smoke
```

Playground app: `apps/playground` (full editor + visual baselines).

## License

MIT — see [LICENSE](LICENSE).
