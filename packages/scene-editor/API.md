# API reference — @scenio/scene-editor

Version: `0.5.0`. Types are the contract; runtime values match the names below. Four entry points: `.` (core), `./element`, `./three`, `./style.css`.

Docs: [English README](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.md) · [简体中文](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.zh-CN.md) · [Project overview](https://github.com/hesetiema/scene-studio/blob/main/README.md)

---

## Core entry — `@scenio/scene-editor`

Headless surface: `createSceneEditor()` facade, document model, validation, history, errors, assets, plugin types, controller. No DOM, no three imports.

### `createSceneEditor()` — headless facade

Zero-DOM editor: state + commands + typed events + plugins. UI, input wiring, and rendering are the host's job.

```ts
const editor = createSceneEditor({ runtime }); // RuntimeContract required
```

| Member | Signature | Description |
|---|---|---|
| constructor | `createSceneEditor({ runtime })` | `runtime: RuntimeContract` required — `FakeRuntime` (tests), `ThreeRuntime`, or custom. Never defaults |
| `loadDocument` | `(input: unknown) => Promise<void>` | zod-validated; emits `error` and rethrows on failure. Serialized: overlapping calls run in call order |
| `getDocument` | `() => SceneDocument` | Deep-clone snapshot |
| `markSaved` | `(serverRevision: number) => void` | Host confirmed save; adopts revision, clears dirty |
| `applyRemote` | `(input, { baseRevision }) => Promise<void>` | Fast-forward or throw structured conflict |
| `select` | `(ids: string[]) => void` | Set semantics |
| `add` / `remove` | `(ids: string[]) => void` | Compose selection (shift/ctrl multi-select) |
| `toggle` | `(id: string) => void` | Flip membership |
| `clearSelection` | `() => void` | |
| `applyTransform` | `(id, from, to) => void` | One undoable command |
| `executeCommand` | `(command: Command) => void` | **First-class entry** for host-defined undoable actions (compare PlayCanvas `history.add`) |
| `undo` / `redo` | `() => boolean` | Whether an action ran |
| `requestSave` | `() => void` | Emits `save-request` with `{ reason: "manual", document, revision }` |
| `getViewState` | `() => ViewState` | Live viewport view |
| `setViewState` | `(view: ViewState) => void` | Record + apply a view; marks dirty, never undoable |
| `on(type, handler)` | returns `() => void` | Typed subscription; call the returned function to unsubscribe |
| `use` / `unuse` | `(plugin) => void` / `(id: string) => void` | Same `install(context)` contract as the element; duplicate id throws |
| `handleKeyDown` | `(event: KeyboardLike) => boolean` | Pure key mapping (Ctrl/Cmd+Z undo, +Shift/Z or Y redo, reserved G/R/S). Returns `true` when consumed. Focus-domain policy stays with the DOM owner |
| getters | `canUndo` `canRedo` `dirty` `revision` `selectedIds` `runtime` | |
| `destroy` | `() => void` | Idempotent: tears down plugins, flushes controller + runtime disposers, clears handlers. Later calls throw `lifecycle` |

**`SceneEditorEventMap`** (all plain payloads, no CustomEvent): `selection-change` `{ids}` · `history-change` `{canUndo, canRedo, dirty, lastCommand?}` · `document-dirty` `{dirty}` (emitted only on false↔true crossings) · `save-request` `{reason: "manual", document, revision}` · `view-change` `{view: ViewState, source: "interaction" | "api" | "load"}` · `error` `{code, message, cause?}`.

Also exported: `handleEditorKeyCommand(target, event)` — the raw key-mapping function, for hosts that keep their own controller.

### Constants

| Export | Type | Description |
|---|---|---|
| `SCENE_EDITOR_VERSION` | `string` | Package version string, mirrors `package.json` |
| `SUPPORTED_ASSET_FORMATS` | `readonly ["glb", "gltf"]` | Formats the built-in loaders accept |

### Document schema (zod)

| Export | Kind | Description |
|---|---|---|
| `SceneDocumentSchema` | `z.ZodType<SceneDocument>` | Strict object: `schemaVersion` (literal 2), `sceneId`, `revision`, `objects[]`, `view` |
| `ViewStateSchema` | `z.ZodType<ViewState>` | Strict `view` section: `camera`, `lights`, `environment` |
| `SceneObjectSchema` | `z.ZodType<SceneObjectDTO>` | Strict object: `id`, `type` (`"mesh" \| "group"`), `name`, optional `assetId` / `parentId` / `metadata`, required `position` / `rotation` / `scale` tuples |
| `SceneDocument`, `ViewState` | type | Infer of document / view-state schema |
| `Vec3` / `EulerXYZ` | type | `readonly [number, number, number]`; rotation is Euler XYZ in **radians** |

| Function | Signature | Description |
|---|---|---|
| `parseSceneDocument` | `(input: unknown, opts?: ParseSceneDocumentOptions) => SceneDocument` | Migrations run first, then zod parse; throws `SceneEditorError("validation")` on invalid input |
| `migrateSceneDocument` | `(doc: unknown) => MigrationResult` | Generic migration registry: upgrades v1 → v2, reports `applied` |
| `createDefaultViewState` | `() => ViewState` | Engine-default `view` |
| `validateHierarchy` | `(doc: SceneDocument) => void` | Parent references must resolve; throws `SceneEditorError("validation")` |

### Errors

| Export | Description |
|---|---|
| `SceneEditorError` | `class extends Error` with `code: SceneErrorCode`, optional `detail` |
| `SceneErrorCode` | Const enum-like: `validation`, `asset-resolve-failed`, `asset-load-failed`, `render-init-failed`, `lifecycle`, `conflict` |
| `createConflictError(docs)` | Builds `SceneEditorError("conflict")` carrying `{ base, incoming, local }` in `detail` |
| `ConflictDocuments` | type: `{ base, incoming, local: SceneDocument }` |

`AssetError` / `AssetErrorCode` (from assets below) are separate classes; both surface through the element `error` event with string codes.

### Runtime contract

The only seam between Core/Element and any concrete runtime.

```ts
interface RuntimeContract {
  loadDocument(doc: SceneDocument): Promise<void>;
  applyTransform(id: string, t: Transform): void;
  select(ids: string[]): void;
  clearSelection(): void;
  pick(clientX: number, clientY: number): string | null;
  flushDisposers(): void;
  getViewState(): ViewState;
  applyViewState(view: ViewState): void;
  readonly events: RuntimeEventBus;
}

type Transform = {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
};
```

**Runtime events** (`RuntimeEventBus.on(type, handler) => off`):

| Event | Payload |
|---|---|
| `selection-change` | `{ ids: string[] }` |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` |
| `transform-commit` | `{ id, from: Transform, to: Transform }` — one completed gizmo drag |
| `error` | `{ code: string, message: string, cause? }` |
| `view-change` | `{ view: ViewState }` — a **user** interaction ended; never emitted while `applyViewState` runs |

| Export | Description |
|---|---|
| `RuntimeContract`, `RuntimeEventBus`, `RuntimeEventMap`, `Transform` | types above |
| `TypedEventBus` | Default `RuntimeEventBus` implementation |
| `FakeRuntime` | In-memory `RuntimeContract` for unit tests (no GPU) |
| `DisposerStack` | Ordered cleanup stack; `add(fn)`, `flush()` |
| `SelectionManager` | Single/multi selection set; notifies on change |

### History & commands

| Export | Description |
|---|---|
| `CommandHistory` | Undo/redo stack; `execute`, `undo`, `redo`, `markClean`, `clear`; emits `history-change` via callback |
| `Command` | type: `{ label: string; execute(): void; undo(): void }` |
| `HistoryState` | type: `{ canUndo, canRedo, dirty, lastCommand? }` |
| `TransformCommand` | One transform edit as a command (`id`, `from`, `to`, apply fn) |

### EditorController

Glue between an element and a runtime: owns history, selection, document snapshot, disposers.

| Member | Signature | Description |
|---|---|---|
| constructor | `(runtime: RuntimeContract)` | |
| `loadDocument` | `(input: unknown) => Promise<void>` | Parse + hand to runtime; clears history & selection. Serialized — call order decides the final document |
| `getDocument` | `() => SceneDocument` | Deep clone snapshot; throws `lifecycle` if nothing loaded |
| `applyTransform` | `(id, from, to) => void` | One undoable command updating runtime + stored doc |
| `applyRemote` | `(input, { baseRevision }) => Promise<void>` | Fast-forward only if clean and `revision === baseRevision + 1`; otherwise throws structured `conflict` (never auto-merges) |
| `executeCommand` / `undo` / `redo` / `markClean` / `markSaved` | as named | `markSaved(serverRevision)` adopts server revision and clears dirty |
| `select` / `clearSelection` | `(ids) => void` / `() => void` | |
| `canUndo` / `canRedo` / `dirty` / `selectedIds` / `revision` | getters | |
| `getViewState` / `setViewState` / `getSceneId` | `(view?: ViewState)` / `() => ViewState` / `() => string \| null` | View state; `setViewState` marks dirty without a command |
| `handleRuntimeViewChange` | `(view: ViewState) => void` | Record a user-driven view change; wired from `runtime` `view-change` |
| `destroy` | `() => void` | Flushes disposers |
| `disposers` / `history` / `selection` / `runtime` | readonly fields | |

### Assets

| Export | Description |
|---|---|
| `AssetCache` | Refcounted per-`assetId` cache. `retain(id)`, `release(id)`, `has`, `refCount`. Parallel retains collapse to one load; dispose at refcount 0; next retain reloads |
| `AssetLoader` | type: `(assetId: string) => Promise<LoadedAsset>` |
| `LoadedAsset` | type: `{ scene: unknown; dispose?: () => void; metadata?: unknown; animations?: readonly unknown[] }` — opaque runtime handle; glTF clips are forwarded to the runtime |
| `AssetError` / `AssetErrorCode` | Codes: `asset-not-found`, `asset-resolve-failed`, `asset-load-failed`, `asset-unsupported-format`, `asset-disposed` |
| `createGltfAssetLoader(options)` | `{ resolveUrl, gltfLoader, dracoLoader?, ktx2Loader? }` → `AssetLoader` |
| `createResolverAssetLoader(options)` | `{ resolver, gltfLoader, dracoLoader?, ktx2Loader? }` → `AssetLoader`; resolve failure → `asset-resolve-failed` |
| `AssetResolver` | type: `{ resolve(assetId): Promise<string \| URL> }` — host owns URLs |
| `MinimalGltfLoader` | Structural type: `loadAsync(url)`, optional `setDRACOLoader` / `setKTX2Loader` |

### Plugins

| Export | Description |
|---|---|
| `SceneEditorPlugin` | `{ id: string; install(context): void \| (() => void) }` |
| `PluginContext` | `{ runtime, editor, on(type, handler), addDisposer(fn) }` |
| `PluginEditorApi` | `loadDocument`, `getDocument`, `select`, `clearSelection`, `applyTransform`, `undo`, `redo`, `requestSave`, getters `selectedIds` / `dirty` / `revision` / `canUndo` / `canRedo` |

No THREE or GPU internals are exposed to plugins — only the contract + editor API.

---

## Element entry — `@scenio/scene-editor/element`

Web Component wrapper. Side-effect: imports `./styles/scene-editor.css` (re-exported as `@scenio/scene-editor/style.css`).

| Export | Description |
|---|---|
| `defineSceneEditor()` | Registers `<scene-editor>`; idempotent; call at runtime (SSR-safe) |
| `SceneEditorElement` | The custom element class |
| `CAPTURED_COMBOS` | `readonly ["ctrl+z", "ctrl+shift+z", "ctrl+y", "g", "r", "s"]` — keyboard capture list |

### `SceneEditorElement` properties & methods

| Member | Kind | Description |
|---|---|---|
| `runtimeFactory` | **static** | `(canvas, options?) => RuntimeContract`. Defaults to `ThreeRuntime` + lazy GLTF. Override before connect to inject assets / WebGPU / test fakes |
| `assetResolver` | property | Host `AssetResolver`; set **before** connect/ready |
| `ready` | promise | Resolves on init, rejects on failure. Prefer the `error` event as the reliable failure channel |
| `controlsReady` | promise | Resolves when gizmo mounted; non-three runtimes resolve immediately |
| `loadDocument(doc)` | method | Validated load; throws/rejects with typed errors. Overlapping calls are serialized (call order wins) |
| `getDocument()` | method | Detached deep-clone snapshot — never the save trigger |
| `markSaved(revision)` | method | Host confirmed save |
| `selectObject(id)` | method | Single-id convenience |
| `select(ids)` | method | Set the selection to exactly `ids` (multi-select) |
| `addToSelection(ids)` / `removeFromSelection(ids)` / `toggleSelection(id)` | method | Compose the current selection (parity with the facade's `add` / `remove` / `toggle`) |
| `applyTransform(id, from, to)` | method | One undoable command |
| `applyRemote(input, { baseRevision })` | method | Inbound remote update: fast-forward or throw structured `conflict` |
| `executeCommand(cmd)` | method | Escape hatch for custom `Command`s |
| `undo()` / `redo()` | method | Also bound to keyboard (see `CAPTURED_COMBOS`) |
| `requestSave()` | method | Dispatches `save-request` with current document + revision |
| `getViewState()` / `setViewState(view)` | method | View state: live read / record + apply (dirty, not undoable) |
| `use(plugin)` / `unuse(id)` | method | Plugin install/uninstall; pre-connect `use` is queued; duplicate id throws |
| `revision` / `dirty` / `selectedIds` | getters | |
| `connectedCallback` / `disconnectedCallback` | lifecycle | Teardown destroys runtime + all plugins |

### Element events (CustomEvent)

| Event | `detail` | When |
|---|---|---|
| `scene-ready` | — | Init complete |
| `selection-change` | `{ ids: string[] }` | Selection changed |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | Command/undo/redo |
| `document-dirty` | `{ dirty: boolean }` | Dirty crossed the boundary |
| `save-request` | `{ reason: "manual", document, revision }` | Host should persist |
| `view-change` | `{ view, source: "interaction" \| "api" \| "load" }` | Viewport view changed |
| `error` | `{ code, message, cause? }` | Any SDK failure, including runtime/asset errors (`AssetErrorCode` values are forwarded verbatim) |

---

## Three entry — `@scenio/scene-editor/three`

Advanced integration only. All three.js imports live behind this layer — Core/Element never import three.

### ThreeRuntime

| Export | Description |
|---|---|
| `ThreeRuntime` | Production `RuntimeContract` on WebGL2 (default). Owns scene, camera, lights, grid, OrbitControls, TransformControls, raycasting, render loop |
| `ThreeRuntimeOptions` | See below |

```ts
interface ThreeRuntimeOptions {
  canvas: HTMLCanvasElement;
  rendererFactory?: (canvas) => RendererHandle; // default: createRenderer (WebGL2)
  orbitControlsFactory?: (camera, domElement) => { update; dispose } | null;
  transformControlsFactory?: (camera, domElement) => TransformControlsLike;
  enableControls?: boolean; // false = headless
  assetCache?: AssetCache;
  transformMode?: TransformMode; // default: "translate"
}
```

Public members: `scene`, `camera`, `renderer`, `events`, `controlsReady`, `resize(w?, h?)`, `transformMode` (getter), `setTransformMode(mode)`. Scene/camera/lights/grid are engine state — never persisted.

**Gizmo mode.** `TransformMode = "translate" | "rotate" | "scale"`. `setTransformMode()` is safe before the TransformControls addon finishes loading — the mode is remembered and applied on mount, so a host toolbar can bind it during boot:

```ts
const runtime = new ThreeRuntime({ canvas });
runtime.setTransformMode("rotate"); // remembered until the addon mounts
```

**Animation.** Clips from `LoadedAsset.animations` are bound to each mounted asset instance (one mixer per object). One clip plays at a time across the runtime.

| Member | Description |
|---|---|
| `animations` | `AnimationClipInfo[]`: `{ id: "objectId#index", objectId, index, name, duration }` |
| `playAnimation(objectId?, index?)` | Start a clip (`null` objectId = first object with clips); starts an rAF loop |
| `pauseAnimations()` / `resumeAnimations()` | Pause without rewind / continue from the playhead |
| `setAnimationSpeed(speed)` | Playback rate (`0` allowed) |
| `setAnimationTime(seconds)` | Scrub the active clip |
| `animationPlaying` / `animationTime` / `animationDuration` | Transport read surface |

```ts
const runtime = new ThreeRuntime({ canvas, assetCache });
await runtime.loadDocument(doc); // assets with clips register their mixers
runtime.playAnimation("obj-1", 0);
```

### Viewer rigs

`ThreeRuntime` is a thin orchestrator over these composable pieces (same split a standalone glTF viewer uses). Import them from `@scenio/scene-editor/three` to build a viewer without the editor contract.

| Export | Responsibility |
|---|---|
| `createCameraRig` | Camera + OrbitControls lifecycle, `readView()` / `applyView()` |
| `createLightingRig` | Ambient + directional lights, view read/apply |
| `createEnvironmentRig` | Background + floor grid |
| `createObjectStore` | id → Object3D registry, asset instantiation, disposal |
| `createGizmoRig` | TransformControls mount / mode / selection binding |
| `createAnimationRig` | glTF clips, mixers, transport |
| `createRenderLoop` | Single re-entrancy-guarded render entry |

**WebGPU opt-in:** construct a `WebGPURenderer`, `await renderer.init()` **before** constructing the runtime (constructor renders once), pass `rendererFactory: () => renderer`. Detect silent fallback via `renderer.backend.isWebGPUBackend === true`. This seam is the only supported WebGPU path; WebGL2 remains the default and the CI-tested renderer.

### Renderer

| Export | Description |
|---|---|
| `createRenderer(canvas, options?)` | Single creation site for WebGLRenderer; failures → `SceneEditorError("render-init-failed")`. Options: `antialias` (default true), `maxPixelRatio` (default 2) |
| `RendererHandle` | Structural slice: `render`, `setSize`, `setPixelRatio`, `dispose` |
| `CreateRendererOptions` | type above |

### Transform controls binding

| Export | Description |
|---|---|
| `createTransformControlsBinding(options)` | Wraps three `TransformControls`; one drag → one `transform-commit` event |
| `TransformControlsBinding` / `TransformControlsBindingOptions` / `TransformControlsLike` / `TransformSnapshot` | Supporting types |

### Picking

| Export | Description |
|---|---|
| `createPicker(options)` | Raycast helper. `setTargets(objects)`, `pick(clientX, clientY) => id \| null` |
| `Picker` / `PickerOptions` / `RaycastHit` | Types; `PickerOptions.raycast` injects a stub for tests |

### Example plugin

| Export | Description |
|---|---|
| `createSelectionHighlightPlugin(options?)` | Tints selected meshes via emissive highlight; demonstrates `install(context)` + disposer cleanup. Options: `color` (default warm amber), `intensity` |

---

## Style entry — `@scenio/scene-editor/style.css`

Minimal chrome for the custom element (layout of canvas host). Import once in the page that uses `<scene-editor>`; already imported by the element entry.

---

## Related demo code

- `apps/playground/src/main.ts` — composition root: runtimeFactory, assets, save/conflict host store, boot sequence
- `apps/playground/src/viewer/viewer-controller.ts` — viewer state → engine updates (display, environment, animation)
- `apps/playground/src/ui/studio-shell.ts` — composes HUD panels, hotkeys, explode preview
- `apps/playground/src/viewer/display-modes.ts` — shading modes with owned/disposed material overrides
- `apps/playground/src/ui/scene-export.ts` — GLB/OBJ export (document state, not preview) + PNG snapshot
