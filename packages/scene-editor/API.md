# API reference — @scenio/scene-editor

Version: `0.7.0`. Types are the contract; runtime values match the names below. Four entry points: `.` (core), `./element`, `./three`, `./style.css`.

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
| `addObject` | `(dto) => Promise<void>` | Mounts, then appends to the document. Rejects on duplicate id / missing parent / invalid DTO; the document is never given an object whose asset failed |
| `removeObject` | `(id) => void` | Removes the object **and its subtree**, children first. One undo step; undo restores the original array order |
| `reparent` | `(id, parentId) => void` | `undefined` = scene root. Rejects missing parents, self-parenting and cycles |
| `setMaterial` | `(id, material \| undefined) => void` | Sets or clears the override; `undefined` restores what the asset shipped with |
| `executeCommand` | `(command: Command) => void` | **First-class entry** for host-defined undoable actions (compare PlayCanvas `history.add`) |
| `undo` / `redo` | `() => boolean` | Whether an action ran |
| `requestSave` | `() => void` | Emits `save-request` with `{ reason: "manual", document, revision }` |
| `getViewState` | `() => ViewState` | Live viewport view |
| `setViewState` | `(view: ViewState) => void` | Record + apply a view; marks dirty, never undoable |
| `on(type, handler)` | returns `() => void` | Typed subscription; call the returned function to unsubscribe |
| `use` / `unuse` | `(plugin) => void` / `(id: string) => void` | Same `install(context)` contract as the element; duplicate id throws |

`Command` is `{ label, execute(), undo(), mergeWith?(next): boolean }`. `mergeWith` lets the
top command absorb a later one instead of spending an undo step: `setMaterial` uses it so a
slider drag becomes one undo whose `from` is the value before the gesture. Returning `true`
means "absorbed" — the absorbed command's effect stays, its history entry does not.
| `handleKeyDown` | `(event: KeyboardLike) => boolean` | Pure key mapping (Ctrl/Cmd+Z undo, +Shift/Z or Y redo, reserved G/R/S). Returns `true` when consumed. Focus-domain policy stays with the DOM owner |
| getters | `canUndo` `canRedo` `dirty` `revision` `selectedIds` `runtime` | |
| `destroy` | `() => void` | Idempotent: tears down plugins, flushes controller + runtime disposers, clears handlers. Later calls throw `lifecycle` |

**`SceneEditorEventMap`** (all plain payloads, no CustomEvent): `selection-change` `{ids}` · `history-change` `{canUndo, canRedo, dirty, lastCommand?}` · `document-dirty` `{dirty}` (emitted only on false↔true crossings) · `save-request` `{reason: "manual", document, revision}` · `view-change` `{view: ViewState, source: "interaction" | "api" | "load"}` · `view-changing` `{view: ViewState}` (opt-in, high frequency) · `camera-change` `{position, target, fov}` (always on, camera-only) · `environment-change` `{environment, source: "api" | "load"}` (edge-triggered) · `progress` `{totalProgress, reason}` · `load` `{sceneId}` · `play` `{objectId, index, name}` · `pause` `{}` · `loop` `{count, name}` · `finished` `{objectId, name}` · `visibility-change` `{visible: boolean}` (**element-only** — the facade has no DOM and never emits it) · `model-visibility` `{visible: boolean}` (element-only; `loaded` × in-viewport × poster dismissed) · `error` `{code, message, cause?}`.

`SceneEditorElementEventMap` = the map above, with `load` widened to `{sceneId, url: string | null}`, plus `scene-ready: null`. It is the typed source for `el.addEventListener(...)`.

Also exported: `handleEditorKeyCommand(target, event)` — the raw key-mapping function, for hosts that keep their own controller.

### Constants

| Export | Type | Description |
|---|---|---|
| `SCENE_EDITOR_VERSION` | `string` | Package version string, mirrors `package.json` |
| `SUPPORTED_ASSET_FORMATS` | `readonly ["glb", "gltf"]` | Formats the built-in loaders accept |

### Document schema (zod)

| Export | Kind | Description |
|---|---|---|
| `SceneDocumentSchema` | `z.ZodType<SceneDocument>` | Strict object: `schemaVersion` (literal 3), `sceneId`, `revision`, `objects[]`, `view` |
| `ViewStateSchema` | `z.ZodType<ViewState>` | Strict `view` section: `camera`, `lights` (fixed `ambient` + `directional`, optional `additional` array), `environment` |
| `SceneObjectSchema` | `z.ZodType<SceneObjectDTO>` | Strict object: `id`, `type` (`"mesh" \| "group" \| "primitive"`), `name`, optional `assetId` / `parentId` / `geometry` / `material` / `metadata`, required `position` / `rotation` / `scale` tuples. Cross-field refines: `primitive` requires `geometry`, forbids `assetId`; `geometry` is invalid on non-primitives |
| `PrimitiveGeometrySchema` | `z.discriminatedUnion` | `kind`: `box` \| `sphere` \| `cylinder` \| `cone` \| `torus` \| `plane` \| `capsule` \| `icosahedron`. Every size/segment parameter is optional; the three factory applies its documented default |
| `MaterialSchema` | `z.ZodType<MaterialDTO>` | Strict: optional `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`, `opacity`, `flatShading`, `wireframe`. `opacity < 1` implies `transparent` |
| `AdditionalLightSchema` | `z.discriminatedUnion` | `kind`: `directional` \| `point` \| `spot` \| `hemisphere`; used by `view.lights.additional` |
| `SceneDocument`, `SceneObjectDTO`, `SceneObjectType`, `ViewState`, `PrimitiveGeometry`, `MaterialDTO`, `AdditionalLightDTO` | type | Inferred from the schemas above |
| `Vec3` / `EulerXYZ` | type | `readonly [number, number, number]`; rotation is Euler XYZ in **radians** |

| Function | Signature | Description |
|---|---|---|
| `parseSceneDocument` | `(input: unknown, opts?: ParseSceneDocumentOptions) => SceneDocument` | Migrations run first, then zod parse; throws `SceneEditorError("validation")` on invalid input |
| `migrateSceneDocument` | `(doc: unknown) => MigrationResult` | Generic migration registry: walks v1 → v2 → v3, reports every `applied` step. v3 only added optional fields, so a v2 payload survives unchanged |
| `createDefaultViewState` | `() => ViewState` | Engine-default `view` |
| `validateHierarchy` | `(doc: SceneDocument) => void` | Parent references must resolve; throws `SceneEditorError("validation")` |

### Building a document

Writing the six-field envelope by hand (and re-deriving camera/lights/environment every time) is the most repeated host boilerplate; these four helpers remove it. Everything is plain data — no ids are generated, nothing is registered.

| Function | Signature | Description |
|---|---|---|
| `createSceneDocument` | `(opts?: CreateSceneDocumentOptions) => SceneDocument` | Valid document from `{ sceneId?, revision?, objects?, view? }`. `view` is a `ViewPatch` merged over `DEFAULT_VIEW_STATE`; `objects` are deep-cloned |
| `createEmptyDocument` | `(opts?) => SceneDocument` | `createSceneDocument` with `objects: []` |
| `createDocumentFromAsset` | `(opts: CreateDocumentFromAssetOptions) => SceneDocument` | One mesh pointing at `assetId` (or `url`, which becomes the id). Ids default to `${assetId}-mesh` / `scene-${name}`; `baseView` swaps the baseline (`createPreviewViewState()` for viewer-style framing) |
| `applyViewPatch` | `(base: ViewState, patch?: ViewPatch) => ViewState` | Deep merge into a **copy**: `camera`, `lights.ambient`, `lights.directional`, `environment` merge one level down, `lights.additional` replaces wholesale. Never mutates or aliases `base` |
| `assetDisplayName` | `(url: string) => string` | Last path segment, decoded, query/hash stripped — the same naming rule `<scene-editor src>` uses |
| `LIGHTING_PRESETS` | `Record<LightingPresetId, LightingPreset>` | Reference light setups (`studio` / `cyber` / `sunset` / `contrast`), typed against `view.lights`. Data only — apply through `setViewState(applyViewPatch(view, { lights: ... }))`; hosts with their own look define their own table |

```ts
const doc = createDocumentFromAsset({
  assetId: "fox",
  name: "Fox",
  view: { camera: { position: [3.4, 2.1, 3.8] }, environment: { gridVisible: false } },
});
// → { schemaVersion: 3, sceneId: "scene-Fox", objects: [{ id: "fox-mesh", assetId: "fox", … }] }
```

`ViewPatch` is a deep partial of `ViewState`:

```ts
interface ViewPatch {
  camera?: Partial<ViewState["camera"]>;
  lights?: {
    ambient?: Partial<ViewState["lights"]["ambient"]>;
    directional?: Partial<ViewState["lights"]["directional"]>;
    additional?: ViewState["lights"]["additional"];
  };
  environment?: Partial<ViewState["environment"]>;
}
```

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

  // Incremental editing (optional). A runtime that omits these still loads whole
  // documents, but the object commands throw `lifecycle` rather than editing the
  // document without a visible effect.
  addObject?(dto: SceneObjectDTO): void | Promise<void>;
  removeObject?(id: string): void;
  reparent?(id: string, parentId: string | undefined): void;
  setMaterial?(id: string, material: MaterialDTO | undefined): void;

  select(ids: string[]): void;
  clearSelection(): void;
  pick(clientX: number, clientY: number): string | null;
  flushDisposers(): void;
  getViewState(): ViewState;
  applyViewState(view: ViewState): void;
  /** Optional: toggle high-frequency `view-changing` sampling (default off). */
  setLiveViewEvents?(enabled: boolean): void;
  /** Optional: pointer verbs + orbit limits (model-viewer `disable-*` / `min-max-camera-orbit`). */
  setCameraControls?(options: CameraControlsOptions): void;
  /** Optional: turntable rotation; `null` stops it. */
  setAutoRotate?(options: AutoRotateOptions | null): void;
  /** Optional: undo the turntable's accumulated yaw (reads `theta` after). */
  resetTurntableRotation?(theta?: number): void;
  /** Optional: ease to a camera pose (`interpolation-decay`, asymptotic). */
  smoothViewTo?(view: CameraView, decayMs: number): void;
  /** Optional: land on a running ease's goal now. */
  jumpCameraToGoal?(): void;
  /** Optional: CSS `touch-action` for the canvas, held against the addons. */
  setTouchAction?(value: string): void;
  /** Optional: transport policy (`autoplay`, clip name, crossfade, one-shot). */
  setAnimationOptions?(options: AnimationOptions): void;

  // Optional: playback transport (model-viewer's `availableAnimations` /
  // `animationName` / `paused` / `play()` / `pause()` / `currentTime` /
  // `timeScale`). A runtime without an animation rig omits the whole block and
  // the element reports an empty clip list instead of pretending to play.
  readonly animations?: AnimationClipInfo[];
  readonly animationPlaying?: boolean;
  readonly animationTime?: number;
  readonly animationDuration?: number;
  readonly animationSpeed?: number;
  playAnimation?(objectId?: string | null, index?: number): boolean;
  playAnimationByName?(name: string): boolean;
  /** Several clips of one object at once, weights normalized across the call. */
  playAnimationBlend?(
    layers: readonly AnimationBlendLayer[],
    objectId?: string | null,
  ): boolean;
  readonly animationBlend?: readonly AnimationBlendLayer[];
  pauseAnimations?(): void;
  resumeAnimations?(): boolean;
  setAnimationTime?(seconds: number): void;
  setAnimationSpeed?(speed: number): void;

  /** Optional: fit the camera to the content bounds. */
  autoFrame?(): void;
  /** Optional: world point → canvas-local CSS px (drives `slot="hotspot-*"`). */
  projectPoint?(point: Vec3): { x: number; y: number; z?: number; visible: boolean };
  /** Optional: `projectPoint` + the `data-normal` test (`(camera − point) · normal >= 0`). */
  projectHotspot?(
    point: Vec3,
    normal: Vec3,
  ): { x: number; y: number; z?: number; visible: boolean; facingCamera: boolean };
  /** Optional: display transfer function (never persisted). */
  setToneMapping?(mode: "none" | "linear" | "aces" | "agx" | "neutral"): void;
  /** Optional: exposure multiplier. */
  setExposure?(value: number): void;
  /** Optional: viewport shading; covers batched instances. Never persisted. */
  setDisplayMode?(mode: "studio" | "xray" | "wireframe" | "normal" | "clay"): void;
  /** Optional: current shading mode; "studio" when never set. */
  readonly displayMode?: "studio" | "xray" | "wireframe" | "normal" | "clay";
  /** Optional: component explode (0..1). A preview, never a document write. */
  setExplode?(factor: number): void;
  /** Optional: current explode factor (default 0). */
  readonly explode?: number;
  /** Optional: swap the built-in studio IBL (`room` / `neutral` / `legacy`). */
  setEnvironmentPreset?(preset: EnvironmentPreset): void;
  /** Optional: custom HDR/EXR/LDR as the IBL; `null` falls back to the preset. */
  setEnvironmentImage?(url: string | null): void;
  /** Optional: backdrop image; may double as the IBL when no HDR was set. */
  setSkyboxImage?(url: string | null, options: { asEnvironment: boolean }): void;
  /** Optional: `KHR_materials_variants` string table + current pick. */
  readonly variants?: string[];
  readonly variantName?: string | null;
  setVariant?(name: string | null): boolean;
  /** Optional: cameras authored in the asset. */
  readonly cameras?: string[];
  readonly cameraName?: string | null;
  setCameraByName?(name: string | null): boolean;
  /** Optional: morph channels + manual weights. */
  readonly morphTargets?: MorphTargetInfo[];
  setMorphInfluence?(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean;

  readonly events: RuntimeEventBus;
}

/** One clip on the mounted content: `${objectId}#${index}` is the stable id. */
type AnimationClipInfo = {
  id: string;
  objectId: string;
  index: number;
  name: string;
  duration: number;
};

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
| `view-changing` | `{ view: ViewState }` — in-flight camera sample; only after `setLiveViewEvents(true)`, never during `applyViewState`, and only when the camera actually moved |
| `camera-change` | `{ position, target, fov }` — camera-only sample, **always on** (auto-rotate has no gesture to hang an event on). Never emitted during `applyViewState` or for a static re-render |
| `load-progress` | `{ totalProgress: number, reason: string }` — monotonic 0..1 across the document's meshes |
| `load` | `{ sceneId: string }` — the document is mounted and renderable (fires after `load-progress` reaches 1) |
| `play` | `{ objectId, index, name }` — a clip started or resumed |
| `pause` | `null` — playback stopped from a playing state (never on load: a runtime starts paused) |
| `loop` | `{ count, name }` — the clip in flight completed a wrap; `count` starts at 1 per clip |
| `finished` | `{ objectId, name }` — a one-shot clip reached its last frame |

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
| `addObject` / `removeObject` / `reparent` / `setMaterial` | as named | Object-graph commands. `addObject` is async (asset load) and validates through `SceneObjectSchema` + `validateHierarchy`; the rest are synchronous and go through the same hierarchy rules |
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
| `createLazyDecoders({ path, getRenderer? })` | Draco + KTX2 + Meshopt from one base URL. `ready()` imports/configures once (idempotent, never rejects — a module that fails drops that decoder only); `current()` is what the loader reads; `dispose()` kills the decoder workers. This is what `decoder-path` builds |
| `DEFAULT_DECODER_CDN` / `decoderCdn(version?)` | jsDelivr base pinned to three's `REVISION`; `decoderCdn("186")` for a host that pins its own three |
| `createFileBundleUrl(files, opts?)` | `(File[] \| FileList) => Promise<FileBundle>` — see below |
| `assetFormatHint` | `(url, assetId?) => string \| null` — the extension a loader should trust: from the URL when it has one, otherwise from the asset id (`blob:http://host/uuid` has neither, but `upload-1-fox.glb` does) |

#### Uploads — `createFileBundleUrl()`

Turns a dropped/picked file set into one loadable URL. `.glb` / `.obj` / `.stl` become an object URL; a `.gltf` bundle gets every relative `buffers[].uri` / `images[].uri` rewritten to a Blob URL and is itself served from a Blob (three-gltf-viewer's `assetMap` modifier). Absolute, `data:` and existing `blob:` URIs are left alone; a **missing** buffer or image throws `asset-resolve-failed` naming the files, instead of failing later on the first texture.

```ts
interface FileBundle {
  url: string;                    // what the loader fetches
  assetId: string;                // `upload-1-fox.glb` — keeps the extension for the format hint
  name: string;                   // primary file name, extension stripped
  format: "glb" | "gltf" | "obj" | "stl";
  files: readonly File[];         // primary first
  dispose(): void;                // revoke every Blob URL; idempotent
}
```

`.gltf` wins when a drop contains both a `.gltf` and a `.glb` (the bundle owns its resources). `opts.assetIdPrefix` keeps two drops of the same file name apart in `AssetCache`.

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
| `downloadBlob(blob, filename?)` | Save a `Blob` via a temporary anchor. Returns the name used (sanitized, timestamped when empty), so a toast can show it |

### Saving what you exported

The element returns `Blob`s, never files: a host may upload the bytes, show a preview, or skip storage. The save step is one call:

```ts
import { downloadBlob } from "@scenio/scene-editor/element";

downloadBlob(await el.exportDocument({ format: "glb" }), `scene.${format}`);
downloadBlob(await el.toBlob("image/png")!, "shot.png");
```

### Preview mode — `<scene-editor src>`

The shortest path from a glTF URL to a rendered model:

```html
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>
```

- The element synthesizes a one-mesh `SceneDocument` (`assetId: "__src__"`, name taken from the filename), loads it through `createResolverAssetLoader`, then calls `autoFrame()`.
- `progress` / `load` / `error` are the lifecycle surface; `load.url` carries the resolved source.
- Previews default to `tone-mapping="neutral"` (what model-viewer's `auto` resolves to on glTF); pass `tone-mapping="aces"` for the filmic look or `none` to keep three's raw output.
- `loadDocument()` overrides the preview. Changing `src` afterwards switches back to preview and re-frames.
- No resolver is required: a built-in identity resolver maps the reserved asset id to `src`. A host-provided `assetResolver` is wrapped, not replaced — the element's own ids (`__src__`, and the one `loadFiles()` mints) resolve internally, every other id goes to the host table.
- `createSrcDocument(url)`, `SRC_ASSET_ID`, `SRC_SCENE_ID` are exported from `./element` for the same document shape in a headless setup.
- The canvas is **transparent by default** (`WebGLRenderer({ alpha: true })`), so `view.environment.background: null` really shows the page behind the element. Pass `alpha: false` through a custom `runtimeFactory` if you need an opaque canvas.
- `loading="lazy"` defers the `src` load until the element first intersects the viewport (falls back to eager where `IntersectionObserver` is unavailable).
- Viewer chrome is attribute-only and never touches the document: `auto-rotate`, `auto-rotate-delay`, `rotation-per-second`, `min-camera-orbit`, `max-camera-orbit`, `camera-orbit`, `camera-target`, `field-of-view`, `min-field-of-view`, `max-field-of-view`, `disable-pan`, `disable-zoom`, `disable-tap`, `camera-damping`, `autoplay`, `animation-name`, `animation-crossfade-duration`, `pause-at-end`, `environment-image`, `tone-mapping`, `exposure`, `display-mode`, `explode`, `shadow-intensity`, `shadow-softness`, `variant-name`, `camera-name`, `orbit-sensitivity`, `touch-action`, `interpolation-decay`, `skybox-image`, `with-credentials`, `seamless-poster`, `alt`, `decoder-path`, `decoder-cdn`, `instancing`.

- A preview is a **viewer**, so its synthesized view uses viewer defaults rather than editor defaults: no floor grid, `field-of-view="auto"` (30° landscape / 45° portrait), and the environment map as the only light source (analytic ambient/key at `0`). Framing matches model-viewer's default orbit (`0deg 75deg`): front view, 15° above the horizon, at a distance calibrated to the reference viewer's rendered size.
- **Viewer vs editor:** a preview is a viewer (`mode="viewer"`), so it has no authoring chrome — no transform gizmo, no click-to-select, no editor keystrokes. A `loadDocument()` flips the same element to `mode="editor"`; `mode` forces either one and the effective value is mirrored to `data-mode` for CSS. Clearing the selection and tearing the gizmo down happen on the switch, so a viewer never shows leftover axes.
- `load` is dispatched **after** `frameViewer()`: a host reading `getDimensions()` or the camera inside the callback already sees the framed state. Overlapping `src` switches are counted, not flagged — two rapid swaps still release exactly one `load`, carrying the final `url`.
- A preview whose asset **failed** does not dispatch `load` at all: one `src` is one asset, so the store's "skip the broken object, keep the rest" rule leaves an empty scene, and `loaded` stays `false`. The `error` event (and the visible message) is the whole story. Host documents keep partial-success semantics — one bad asset among many still completes a load.
- Failures are visual, not just events: a `slot="error"` child is shown on `error` (or an init failure), and without one the element paints a built-in message over the canvas. The next successful load clears it.
- Clip planes follow the content, not a constant: `near/far` are re-derived from the camera-to-target distance and the content radius every frame, so millimetre CAD and kilometre terrain both stay visible.
- The contact shadow is model-viewer's `Shadow`, not a projected shadow map: an orthographic camera stands on the floor looking **up**, the content renders with a depth material whose alpha is "height above the floor", the result is blurred twice, and a floor quad draws it as pure absorbance. That is why it hugs the footprint instead of stretching away from the feet. `shadow-softness` trades texture resolution (`2^9` → `2^6` texels) and the far plane, so a crisp shadow keeps only the contact band; `shadow-intensity` is the quad's ceiling opacity, eased down for hard shadows. Animated content gets a cubic shadow volume 2x its largest dimension, with the texture scaled 4x so texels stay the same size in world units.

Deliberately not implemented: `interaction-prompt` / `interaction-prompt-threshold` (the "drag to rotate" hint). This viewer draws a canvas and nothing else — every other affordance is the host page's business, and a hint that steals attention from the model is the host's call, not the component's. Model-viewer's other chrome (`poster` / `progress-bar` / `reveal`) exists because it also owns the loading experience; here those are slots.

#### Compressed glTF: `decoder-path` / `decoder-cdn`

`GLTFLoader` throws `No DRACOLoader instance provided.` on a Draco GLB, `KTX2Loader: Missing initialization` on KTX2 textures, and `setMeshoptDecoder must be called` on Meshopt — three wants constructed instances, not configuration. One attribute removes that homework:

```html
<scene-editor src="/models/robot.glb" decoder-path="/decoders/"></scene-editor>
```

The base URL holds three's own payload layout — copying `node_modules/three/examples/jsm/libs/{draco,basis}` there **is** the self-hosting story:

```
/decoders/
  draco/gltf/   draco_wasm_wrapper.js + draco_decoder.wasm
  basis/        basis_transcoder.js + basis_transcoder.wasm
```

- **Fetched on the first load, once.** The three addon modules are dynamic imports (their own chunk, never in the main bundle) and are pulled the first time a load starts on a page that opted in — three needs the instances before it parses. The *payloads* are lazier than that: `DRACOLoader` is only configured, so the draco wasm and the basis transcoder are fetched by three inside the first compressed primitive/texture. A page of uncompressed models therefore downloads the small addon chunk and no payloads.
- **`decoder-cdn`** uses `DEFAULT_DECODER_CDN`, pinned to the three version this build was compiled against (`three@0.<REVISION>.0` on jsDelivr). Decoder payloads are version-coupled: an r186 wrapper around an r180 wasm is undefined behaviour, which is why the URL follows `REVISION` instead of floating.
- **KTX2 needs the renderer.** `KTX2Loader.detectSupport(renderer)` probes the device to choose a compressed texture target; guessing would upload unreadable textures. The default runtime exposes `RuntimeContract.renderer`, so KTX2 is wired automatically; a runtime that omits it loses KTX2 only (Draco + Meshopt still work) rather than lying about device support.
- **A host-assigned decoder wins.** `el.dracoLoader = …` overrides the bundle for that one format; the others stay automatic.
- **Failures name the fix.** The `error` message is `Failed to load asset: <id> — this model uses Draco-compressed geometry, which needs a decoder — set decoder-path …`, so the built-in overlay (or `slot="error"`) is actionable instead of a three stack frame.
- Changing either attribute rebuilds the bundle; the effect lands on the **next** load, since a fetch already in flight owns its decoders. Both are presentation-only — never written to the document.

### `SceneEditorElement` properties & methods

| Member | Kind | Description |
|---|---|---|
| `runtimeFactory` | **static** | `(canvas, options?) => RuntimeContract`. Defaults to `ThreeRuntime` + lazy GLTF. Override before connect to inject assets / WebGPU / test fakes |
| `assetResolver` | property | Host `AssetResolver`; set **before** connect/ready |
| `src` | attribute / property | Preview source (`glb` / `gltf`). Synthesizes a one-mesh document and auto-frames it. An explicit `loadDocument()` takes precedence until `src` changes again |
| `mode` | attribute / property | `viewer` \| `editor`. Absent = derived: `src` preview → viewer, host document → editor. A viewer keeps orbit/zoom and drops authoring chrome (gizmo, click-to-select, `G`/`R`/`S`, undo keys). Effective value mirrored to `data-mode` |
| `tone-mapping` | attribute | `none` \| `linear` \| `aces` \| `agx` \| `neutral`. Previews default to `neutral` (model-viewer's `auto` on glTF); documents stay on the engine default unless set. Shader relink is automatic: three's program cache key includes the tone mapping |
| `exposure` | attribute | Exposure multiplier applied on top of the tone mapping |
| `display-mode` | attribute / property | Viewport shading: `studio` (default) \| `xray` \| `wireframe` \| `normal` \| `clay`. Swaps every rendered mesh — including `InstancedMesh` batches — to one shared override material and restores the originals exactly on `studio`. Invalid spellings fall back to `studio`; presentation-only, re-applied to freshly mounted content |
| `explode` | attribute / property | Component explode, `0..1` (clamped). Objects are offset from their **document** positions along (centre − scene centre), so the document is never written and `0` restores exactly. A document load resets to 0, then the attribute re-asserts; batched instances follow via the transform-invalidate path |
| `shadow-intensity` / `shadow-softness` | attributes | Contact shadow, model-viewer units (`0..1`). `softness` drives both blur radius and the height range that stays dark; `intensity="0"` removes the shadow. Display-only, re-asserted after every load |
| `variant-name` | attribute / property | `KHR_materials_variants` pick; `null` restores the asset's own materials. Names set before the asset arrives are remembered. Also `availableVariants` (getter) |
| `camera-name` | attribute / property | Look through a camera authored in the asset (glTF `node.camera`), keeping orbit controls live. Also `cameras` (getter) and `setCameraByName(name)` |
| `morphTargets` / `setMorphInfluence(objectId, meshIndex, targetIndex, value)` | getter / method | Manual morph weights. Channels a playing clip drives are reported `driven: true` and refuse writes (the mixer would overwrite them next frame) |
| `dracoLoader` / `ktx2Loader` / `meshoptDecoder` | properties | Assign **instances** (a `KTX2Loader` must already have `detectSupport(renderer)` called). Read before every asset load, so they may be set before or between loads. A property always wins over `decoder-path`, so a host can override one decoder and keep the rest automatic |
| `decoder-path` | attribute | Base URL of the decoder payloads. Setting it makes Draco / KTX2 / Meshopt GLBs openable without any host wiring; absent (the default) means "no decoders, no extra requests". Nothing is downloaded until the first load needs it |
| `decoder-cdn` | attribute | Boolean: use the CDN base pinned to this build's three version (`DEFAULT_DECODER_CDN`). `decoder-path` overrides it, so a template can keep the flag and point one environment at a mirror |
| `instancing` | attribute / property | Draw-call batching (default **on**). `instancing="false"` (also `0` / `off` / `no`) gives every object its own draw call — the escape hatch for hosts that inspect the scene graph and expect one rendered mesh per object. Live: toggling it re-evaluates the mounted content without a reload, and the document never changes |
| `alt` | attribute | Accessible name of the canvas (`role="img"` + `aria-label`). Falls back to the file name of `src`, so the canvas is never unlabelled |
| `getCameraOrbit()` / `setCameraOrbit({ theta, phi, radius })` | method | model-viewer orbit angles: `theta` azimuth from +Z toward +X, `phi` polar from +Y (both degrees), `radius` in world units. Missing axes keep their value ("`auto`") |
| `getCameraTarget()` / `setCameraTarget([x, y, z])` | method | Orbit target; moving it translates the eye and keeps the angles |
| `getFieldOfView()` / `setFieldOfView(deg)` | method | Rendered vertical FOV, clamped by `min-field-of-view` / `max-field-of-view` when set |
| `availableAnimations` | getter | Clip names (de-duplicated) — model-viewer's `availableAnimations` |
| `animationName` | property | Active clip; assigning it selects **and** starts that clip (a paused transport only changes which clip it will resume) |
| `paused` / `play()` / `pause()` | | Transport. `play()` resumes a paused clip from its playhead, otherwise starts `animation-name` (or the first clip). `pause()` outranks `autoplay` for every later load |
| `currentTime` / `timeScale` | property | Playhead (seconds, settable) and playback rate (`0` freezes the mixer). Timelines only; never written to the document |
| `environment-image` | attribute | Either a preset — `neutral` \| `room` \| `legacy` (the built-in studio IBL; previews default to `neutral`, documents to `room`, `legacy` is an alias of `room`) — **or** an HDR/EXR/LDR URL. A URL only changes the reflections, never the backdrop. Inert while the view supplies an HDR asset |
| `skybox-image` | attribute | URL of the visible backdrop. When `environment-image` has no URL it also becomes the light probe, so one download both lights and shows (a URL `environment-image` wins as the probe). Removing it restores the preset |
| `orbit-sensitivity` | attribute | Drag multiplier mapped to OrbitControls' `rotateSpeed` (default `1`). `0` freezes the orbit, a negative value inverts it — the usual way to inspect a `radius="0"` interior |
| `zoom-sensitivity` / `pan-sensitivity` | attributes | The same multiplier for the wheel (`zoomSpeed`) and the two-finger pan (`panSpeed`), default `1`. `zoom-sensitivity="0"` freezes the wheel while the drag still orbits |
| `touch-action` | attribute | `none` \| `pan-x` \| `pan-y` (default `pan-y`): which gestures stay the browser's, so a viewer in a long page does not hijack vertical scroll. `auto` is deliberately rejected — it is the hijack. Passed as an attribute rather than CSS because iOS ignores `touch-action` on a canvas |
| `interpolation-decay` | attribute | Milliseconds for a `camera-orbit` / `field-of-view` / API pose change to fade instead of snapping (default `50`; only positive values are meaningful — model-viewer's own option list is "values greater than 0", so a non-positive value falls back to the default and `jumpCameraToGoal()` is the way to land now). Asymptotic — `1 - e^(-3t/decay)`, never a truncated ramp |
| `with-credentials` | attribute | Send cookies/HTTP auth with every asset fetch, read at load time so setting it before the fetch is enough (applies to the model and its external buffers) |
| `jumpCameraToGoal()` | method | Land on the last eased pose immediately (`interpolation-decay` fade in flight). Returns `false` when the runtime cannot ease |
| `resetTurntableRotation(theta?)` | method | Undo the turntable's accumulated yaw; the turntable reads `theta` (default `0`) afterwards. The orbit the user dragged to is untouched. Returns `false` when unsupported |
| `frameModel()` | method | Fit the camera to the current bounds ("reset view"); never marks the document dirty |
| `getDimensions()` | method | World-space `{ width, height, depth }` of the mounted content; zeros when the scene is empty |
| `positionAndNormalFromPoint(x, y)` | method | `{ position, normal }` under a client coordinate, or `null` when the ray misses |
| `queryHotspot(name)` | method | Live state of a `slot="hotspot-<name>"` anchor: `{ position, normal, canvasPosition, facingCamera }`, or `null` when no anchor carries that slot / the projection is non-finite. The vectors are `{x, y, z}` objects (model-viewer's shape), unlike this repo's tuples — host code written for model-viewer keeps working |
| `updateHotspot({ name, position?, normal?, surface? })` | method | Move an anchor without touching the DOM: `name` is the full slot name (`"hotspot-tank"`), `position` / `normal` are **strings** in `data-position` / `data-normal` syntax (`"1m 2m 3m"` accepted). Omitted fields are left alone, unparseable fields are ignored, unknown names are a silent no-op. `surface` is accepted for signature compatibility and has no effect (surface tracking is not implemented) |
| `toDataURL(type?, quality?)` / `toBlob(type?, quality?)` | method | Render, then capture the canvas (`image/png` by default). Throws a `lifecycle` error when the runtime cannot capture |
| `exportScene({ binary? })` | method | Export the document objects as GLB (`binary: true`, the default) or `.gltf` JSON. Throws a `lifecycle` error when unsupported |
| `exportDocument({ format? })` | method | Export the **document** as a `Blob` — `glb` (default), `gltf` or `obj`. Unlike `exportScene()` it re-applies the stored transforms onto clones, so preview-only state (explode offsets, display-mode materials, a gizmo mid-drag) never reaches the file. Clips stay with the asset. Throws `lifecycle` when the runtime has no `exportDocument` |
| `loadFiles(files)` | method | Load a dropped/picked file set (`.glb`, `.gltf` + `.bin`/textures, `.obj`, `.stl`). Picks the primary file (`createFileBundleUrl`), mints the Blob URLs, synthesizes the one-mesh document (`createDocumentFromAsset`), then runs the `src` path: decoders, framing, held `load` event, error overlay. The bundle is revoked on the next `loadFiles()` / on disconnect. Requires the runtime to honour `RuntimeFactoryOptions.assetResolver` (the default factory does) |
| `dismissPoster()` | method | Hide `slot="poster"` now and dispatch `poster-dismissed`; idempotent |
| `refreshSlots()` | method | Re-scan `slot="…"` children. A `MutationObserver` (subtree) already covers `slot` / `data-position` / `data-normal` / `data-visibility-attribute` changes, so this is only an explicit flush |
| `ready` | promise | Resolves on init, rejects on failure. Prefer the `error` event as the reliable failure channel |
| `controlsReady` | promise | Resolves when gizmo mounted; non-three runtimes resolve immediately |
| `loadDocument(doc)` | method | Validated load; throws/rejects with typed errors. Overlapping calls are serialized (call order wins) |
| `getDocument()` | method | Detached deep-clone snapshot — never the save trigger |
| `markSaved(revision)` | method | Host confirmed save |
| `selectObject(id)` | method | Single-id convenience |
| `select(ids)` | method | Set the selection to exactly `ids` (multi-select) |
| `addToSelection(ids)` / `removeFromSelection(ids)` / `toggleSelection(id)` | method | Compose the current selection (parity with the facade's `add` / `remove` / `toggle`) |
| `applyTransform(id, from, to)` | method | One undoable command |
| `addObject(dto)` | method | Async; resolves after the object is mounted and recorded |
| `removeObject(id)` / `reparent(id, parentId)` / `setMaterial(id, material)` | method | Undoable object-graph edits (see the facade table above) |
| `applyRemote(input, { baseRevision })` | method | Inbound remote update: fast-forward or throw structured `conflict` |
| `executeCommand(cmd)` | method | Escape hatch for custom `Command`s |
| `undo()` / `redo()` | method | Also bound to keyboard (see `CAPTURED_COMBOS`) |
| `requestSave()` | method | Dispatches `save-request` with current document + revision |
| `getViewState()` / `setViewState(view)` | method | View state: live read / record + apply (dirty, not undoable) |
| `use(plugin)` / `unuse(id)` | method | Plugin install/uninstall; pre-connect `use` is queued; duplicate id throws |
| `revision` / `dirty` / `selectedIds` | getters | |
| `visible` | getter | Whether the element currently intersects the viewport; mirrors `visibility-change` without waiting for an event |
| `loaded` | getter | model-viewer's `loaded`: the `load` event has fired for the current source. Reset by a new load and by teardown — it answers "is there content", not "is it on screen" |
| `modelIsVisible` | getter | model-viewer's `modelIsVisible`: `loaded` **and** in the viewport **and** the poster dismissed. Platforms without an `IntersectionObserver` count as in-viewport, as in the reference |
| `live-view-events` | attribute | Opt in to the high-frequency `view-changing` event. Toggleable at runtime |
| `loading` | attribute | `auto` (default) \| `lazy` \| `eager`. `lazy` defers the `src` load until first visibility; switching back to `eager` flushes it |
| `reveal` | attribute | `auto` (default) \| `interaction` \| `manual`. `auto` dismisses the poster on `load`, `interaction` on the first gesture, `manual` only through `dismissPoster()`. Inert when no `slot="poster"` exists |
| `auto-rotate` / `auto-rotate-delay` / `rotation-per-second` | attributes | Turntable rotation (default idle 3000 ms, 30°/s). Rotation pauses during a drag and resumes after the idle delay |
| `min-camera-orbit` / `max-camera-orbit` | attributes | `"<theta> <phi> <radius>"` per axis, model-viewer syntax: `auto`, `90deg`, `1.2rad`, `2m`. `auto` on either side leaves the axis unlimited |
| `camera-orbit` / `camera-target` / `field-of-view` | attributes | Declarative pose, same syntax as above (`camera-target` is `"x y z"`). `auto` keeps the current axis; `camera-name` outranks them. Re-asserted after every load, never persisted |
| `min-field-of-view` / `max-field-of-view` | attributes | Clamp for `field-of-view` / `setFieldOfView()`; absent = no clamp |
| `camera-damping` | attribute | Orbit inertia as OrbitControls' `dampingFactor` (bare attribute = `0.08`). A settle loop keeps rendering until the controls stop moving |
| `seamless-poster` | attribute | Cross-fade the poster out over 300 ms after the first frame instead of swapping in one frame |
| Keyboard | behaviour | Arrows orbit (5°, `Shift` = 1°), `+`/`-` dolly ±10%, only when focus is inside the element and the editor did not claim the key |
| `disable-pan` / `disable-zoom` / `disable-tap` | attributes | Pointer verbs. `disable-tap` keeps orbit but never converts a click into a selection |
| `autoplay` / `animation-name` / `animation-crossfade-duration` / `pause-at-end` | attributes | Playback transport for glTF clips (`animation-name` is case-insensitive; crossfade is in **ms**) |
| `visibilityObserverFactory` | **static** | Seam for `visibility-change`; default uses `IntersectionObserver`, return `null` to disable |
| `connectedCallback` / `disconnectedCallback` | lifecycle | Teardown destroys runtime + all plugins |

### Slots (light DOM)

`<scene-editor>` has no shadow root, so slots are **plain children tagged with `slot="…"`** — `querySelector`, framework refs and CSS selectors keep working.

```html
<scene-editor src="/models/robot.glb" reveal="interaction">
  <img slot="poster" src="/poster.jpg" alt="Loading robot" />
  <div slot="progress-bar">Loading…</div>
  <div slot="error">模型加载失败，请稍后重试</div>
  <div slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">Lens</div>
</scene-editor>
```

| Slot | Behaviour |
|---|---|
| `poster` | Absolute overlay (z-index 1), shown until the reveal policy dismisses it |
| `progress-bar` | Absolute bottom overlay (z-index 2), visible only while a load is in flight |
| `error` | Covers the canvas (z-index 4) while the last load / init failed; hidden again on the next load. Without this slot the element paints its own message (`[data-scene-editor-error]`) |
| `hotspot-*` | Anchor glued to the world point in `data-position="x y z"` (re-projected on `camera-change` and resize). Hidden while the point is behind the camera. `data-normal="x y z"` (default `0 1 0`) is the surface's front: once `(camera − point) · normal < 0` the anchor gets `opacity: var(--min-hotspot-opacity, 0.25)`, `data-<data-visibility-attribute>` is mirrored, and `hotspot-visibility` fires **on change only** |

Hotspots can also be driven from code: `queryHotspot(name)` reports the screen position and facing so a host can draw leader lines or collision-sort labels, `updateHotspot({ name, position, normal })` moves an anchor from script (model-viewer's API, string coordinates included), and `positionAndNormalFromPoint()` produces the `data-position` / `data-normal` pair to paste in. **Not implemented** (deliberately deferred): `data-surface` / `surfaceFromPoint()` — anchors that follow a skinned mesh move. Note the asymmetry with model-viewer: it does **not** watch `data-position` / `data-normal` and requires `updateHotspot()`; this element watches both (slot observer, `subtree: true`), so either route works — the attribute wins whenever it changes again.

The element only sets `position: relative` on itself when the computed position is `static`. Nodes it adopts keep their own inline CSS, which is restored verbatim when they are removed or re-slotted.

### Element events (CustomEvent)

Every event is dispatched **on the element itself** with `bubbles: false`, `composed: false`, `cancelable: false`. That is part of the contract, not an implementation detail: bind a direct listener or a framework ref, never rely on event delegation, and never expect `preventDefault()` to change SDK behaviour.

| Event | `detail` | Bubbles | Composed | When | Since |
|---|---|---|---|---|---|
| `scene-ready` | `null` | no | no | Init complete; canvas + runtime live. **Element-only** | ≤ 0.5.0 |
| `progress` | `{ totalProgress: number, reason: string }` | no | no | Load progress, monotonic 0..1. Not a success signal | 0.6.0 |
| `load` | `{ sceneId, url: string \| null }` | no | no | Document mounted and renderable; `url` is set only for the `src` path | 0.6.0 |
| `selection-change` | `{ ids: string[] }` | no | no | Selection changed (click, API, clear) | ≤ 0.5.0 |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | no | no | Command executed / undo / redo | ≤ 0.5.0 |
| `document-dirty` | `{ dirty: boolean }` | no | no | Dirty crossed false↔true (edge-triggered) | ≤ 0.5.0 |
| `save-request` | `{ reason: "manual", document, revision }` | no | no | Host should persist; confirm with `markSaved()` | ≤ 0.5.0 |
| `view-change` | `{ view: ViewState, source: "interaction" \| "api" \| "load" }` | no | no | Settled view (one per gesture / API call / scene load) | ≤ 0.5.0 |
| `view-changing` | `{ view: ViewState }` | no | no | In-flight camera sample. **Opt-in** via `live-view-events`; high frequency | 0.6.0 |
| `camera-change` | `{ position, target, fov }` | no | no | Camera pose on every frame it moved (drag, damping, auto-rotate). Always on; camera-only | 0.7.0 |
| `environment-change` | `{ environment, source: "api" \| "load" }` | no | no | Background / grid / IBL / HDR / contact shadow changed (edge-triggered) | 0.7.0 |
| `visibility-change` | `{ visible: boolean }` | no | no | Element entered/left the viewport. **Element-only** | 0.6.0 |
| `model-visibility` | `{ visible: boolean }` | no | no | model-viewer's verdict: `loaded` **and** in the viewport **and** the poster dismissed (the `modelIsVisible` getter). Edge-triggered — a poster appearing or being dismissed counts as a crossing. **Element-only** | 0.7.0 |
| `play` | `{ objectId, index, name }` | no | no | A clip started or resumed. Never fires for an empty clip list | 0.7.0 |
| `pause` | `{}` | no | no | Playback was stopped from a playing state. A viewer starts paused, so this never fires on load | 0.7.0 |
| `loop` | `{ count, name }` | no | no | The clip in flight completed a wrap; `count` starts at 1 for each new clip (three's own wrap counter) | 0.7.0 |
| `finished` | `{ objectId, name }` | no | no | A one-shot clip (`pause-at-end`) reached its last frame | 0.7.0 |
| `poster-dismissed` | `{}` | no | no | The `slot="poster"` overlay was dismissed (auto after load, first interaction, or `dismissPoster()`). Edge-triggered. **Element-only** | 0.7.0 |
| `error` | `{ code, message, cause? }` | no | no | Any SDK failure, including runtime/asset errors (`AssetErrorCode` values are forwarded verbatim) | ≤ 0.5.0 |

Typed listeners come from `SceneEditorElementEventMap`:

```ts
el.addEventListener("view-change", (event) => {
  event.detail.view.camera.fov; // inferred, no cast
});
el.addEventListener("scene-ready", () => {});
```

**`view-changing` is opt-in on purpose.** It fires on every damped camera frame; persisting or POSTing on it will melt the host. Use it only for live consumers (remote camera sync, recording, a numeric HUD) and keep `view-change` for persistence:

```html
<scene-editor live-view-events></scene-editor>
```

```ts
el.addEventListener("view-changing", ({ detail }) => sendCamera(detail.view));
el.addEventListener("view-change", ({ detail }) => persistView(detail.view));
```

Programmatic `setViewState()` and document loads never produce `view-changing`; only real camera movement does. Toggling the attribute on/off is safe at runtime — enabling seeds the sampler, so the current view is never re-announced.

**`visibility-change` is element-only.** The headless facade owns no DOM, so `editor.on("visibility-change")` is typed but never fires — listen on the element. It is backed by `IntersectionObserver`; platforms without one (SSR, some test DOMs) stay silent, and `SceneEditorElement.visibilityObserverFactory = () => null` disables it explicitly. Read the current state without waiting via `el.visible`.

### Event contract & versioning

Events are a published contract, versioned with the package:

1. **Names never change inside a major.** Additions ship in a minor; removal or renaming waits for a major.
2. **Payloads only grow.** New fields are optional; existing field types never widen or narrow in a minor.
3. **Edge-triggered stays edge-triggered.** `document-dirty`, `visibility-change`, `model-visibility`, `environment-change`, `play`, `pause` and `finished` fire only on crossings. Per-frame events are `camera-change` (always on, camera-only, six numbers) and `view-changing` (opt-in, full `ViewState`).
4. **Deprecation has a tail.** A retired event is marked `@deprecated` for at least one minor while still being dispatched, then removed in the next major. Downstream code cannot detect a silently vanished event — model-viewer's old `scene-graph-ready` / `preload` are still listened to by popular wrappers while the current implementation no longer dispatches them.
5. **Dispatch flags are part of the contract.** `bubbles` / `composed` / `cancelable` are fixed at `false`; changing any of them is a breaking change.
6. **Errors carry a stable `code`.** Codes are documented, never reused, and hosts branch on `code` — never on `message`.

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
  interactive?: boolean; // false = viewer: no gizmo at all (default true)
  instancing?: boolean; // false = one draw call per mesh (default true; live via setInstancing)
  resources?: SharedResourcePool; // placeholder geometry/material dedupe (default: one per runtime)
  assetCache?: AssetCache;
  transformMode?: TransformMode; // default: "translate"
}
```

Public members: `scene`, `camera`, `renderer`, `events`, `controlsReady`, `resize(w?, h?)`, `interactive` (getter), `setInteractive(on)`, `instancing` (via `setInstancing(on)`), `resourceStats` (getter), `transformMode` (getter), `setTransformMode(mode)`. Scene/camera/lights/grid are engine state — never persisted.

Export surface: `exportScene({ binary? })` writes the **live** roots (`ArrayBuffer` / `.gltf` JSON string); `exportDocument(doc, { format? })` writes a document's stored transforms as a `Blob` (`glb` default, `gltf`, `obj`). The second one exists because preview state lives on the same objects — an exploded view or a display-mode material would otherwise end up in the file. Both import their exporter on demand, and neither carries animation clips (clips belong to the asset, not the document).

`setInteractive(false)` disposes the gizmo (never mounts the addon in the first place when passed as an option) and clears the selection; `setInteractive(true)` re-mounts it through the same factory. `<scene-editor mode="viewer">` drives this.

**Draw-call batching** (`instancing: true`, the default) collapses repeated primitive meshes into `InstancedMesh`es grouped by `(geometry parameters, material fields)`. The object model does not change: every document object keeps its own `Object3D`, transform, material instance and pick entry, so `getObjectById()`, `exportScene()`, undo and the gizmo behave exactly as before — only the *drawing* is shared. Object identities move to layer `1` (`BATCH_PROXY_LAYER`) so the camera no longer renders them:

- **Picking is unaffected inside the SDK** (`picker.ts` calls `raycaster.layers.enableAll()`), but a host that raycasts the scene itself must enable the layer too, or call `pick()`.
- **Selected objects, material overrides and asset instances are never batched** — each needs its own draw call and gets one.
- **Not batched at all**: glTF assets, transparent/`opacity < 1` materials, sub-tree roots, non-default-layer meshes, and materials with fields that cannot be fingerprinted exactly (`clippingPlanes`, arrays, custom records).
- **Chunked, spatially**: a group is cut into `InstancedMesh`es of ≤256 instances, bucketed by world position (a grid cell per chunk), so three's per-mesh frustum test still culls — a narrow close-up submits about a third of a 5 000-object scene instead of all of it, and the fraction keeps falling as scenes grow. Chunks share one geometry + one material clone per group. Measured 5 000 boxes: 22 560 → 30 720 triangles for a wide view, 60 000 → 18 432 for a close-up, 1 881 → 20 draw calls.
- **Live switch**: `setInstancing(false)` re-evaluates every mounted object (default layer back, batch root removed) without a reload; `setInstancing(true)` re-absorbs whatever is eligible. `<scene-editor instancing="false">` drives it.
- **Cost**: rarer, longer draw calls — sorting a group by cell happens once per membership change (on the next frame), not per object, and a moved instance keeps its old chunk until the next add/remove (its chunk's bounding sphere grows with it, so nothing is culled wrongly — just less tightly). Set `instancing: false` when a host inspects the scene graph and expects one rendered mesh per object.

**Placeholder resources** are shared and reference-counted. Every primitive and placeholder draws its geometry and base material from one pool keyed by content (`primitiveSignature`), so a document of 5 000 identical boxes allocates **one** `BoxGeometry` and **one** `MeshStandardMaterial` instead of 10 000 objects' worth — measured 26.5 MB → 11.0 MB of JS heap for the 5 000-box scene. Consequences for a host:

- `object.geometry` / `object.material` may be shared; mutating one in place is visible everywhere it is used (the SDK never does — a document material goes through `applyMaterialOverride`, which clones).
- The placeholder's `dispose()` releases a *reference*; the buffer is freed when the last member goes.
- `runtime.resourceStats` reports `{ geometries, materials, references }` live; `new ThreeRuntime({ resources })` lets several runtimes share one pool (the caller then owns its lifetime).
- In the default bench: `perf.html` asserts `geometries === 1` for its 1 000-box document.

**Asset static merge.** Draw-call batching only folds *instanced* repeats; a glTF modelled as 200 separate meshes that share one material is still 200 draw calls. On mount, `mergeAssetMeshes()` concatenates those meshes (baking each node's transform into its geometry) into one mesh per material. It is applied only where identity does not matter: the asset must have **no animation clips** and **no `KHR_materials_variants`** (a variant switch rewrites `mesh.material` per node), and each merged mesh must be a leaf with one opaque material and no skin/morph. Picking is unaffected — every node of an asset already reports the document object id. Measured: 200 same-material boxes → 1 mesh in ~25 ms. The merge is undone (and its buffers freed) on `remove()`.

**Clip planes** are content-relative, not constants: every render re-derives `near = max(distance·5e-4, radius·1e-4)` and `far = max(distance·50, radius·50)` from the camera→target distance and the cached content radius. That is what keeps a 10³-unit CAD assembly and a 10⁵-unit terrain both visible through `autoFrame()` / `frameViewer()` and every dolly in between.

Viewer-side policy setters (all optional on `RuntimeContract`, all presentation-only — they never touch the document):

| Method | Description |
|---|---|
| `setCameraControls({ pan?, zoom?, limits?, sensitivity?, zoomSensitivity?, panSensitivity? })` | Orbit limits in **degrees** (`theta` = azimuth, `phi` = polar from +Y) and world-unit `radius`; the three multipliers map onto `rotateSpeed` / `zoomSpeed` / `panSpeed` and accept `0` (freeze that verb) and negatives (invert). Applied on mount if the addon is still loading |
| `setAutoRotate({ enabled, degreesPerSecond?, delayMs? } \| null)` | Turntable yaw stepped from rAF with a real delta; pauses during a drag, resumes `delayMs` after `end` |
| `setDisplayMode("studio" \| "xray" \| "wireframe" \| "normal" \| "clay")` / `displayMode` | Viewport shading. One shared override material per mode is swapped onto **document meshes and instancing chunks alike** (repainting only the hidden proxies would leave a 5 000-object scene unstyled); `"studio"` restores the originals exactly. Read back through `displayMode` |
| `setExplode(factor)` / `explode` | Component explode (0..1). Offsets are recomputed from the **document** positions every call, written through the object store's transform path so `InstancedMesh` matrices follow; a load resets to 0 |
| `setAnimationOptions({ autoplay?, clipName?, crossfadeSeconds?, pauseAtEnd? })` | Transport policy; `autoplay` also applies to already-mounted content |
| `smoothViewTo(view, decayMs)` / `jumpCameraToGoal()` | Pose transition instead of a snap: the camera arcs (slerp on the offset, linear on radius) and lands asymptotically. `jumpCameraToGoal()` collapses a running ease |
| `resetTurntableRotation(theta?)` | Roll back the yaw the **turntable** added, leaving the user's orbit alone. After the call the turntable reads `theta` (default `0`) |
| `setTouchAction(value)` | Holds the canvas's `touch-action` against `OrbitControls` **and** `TransformControls`, which both write `none` on connect from their own async imports (see `viewer/touch-action-owner.ts`) |
| `setEnvironmentImage(url \| null)` / `setSkyboxImage(url \| null, { asEnvironment })` | Custom HDR/EXR/LDR light probe and backdrop. `skybox` doubles as the probe when no `environment-image` URL is set, so one download lights and shows |

**Gizmo mode.** `TransformMode = "translate" | "rotate" | "scale"`. `setTransformMode()` is safe before the TransformControls addon finishes loading — the mode is remembered and applied on mount, so a host toolbar can bind it during boot:

```ts
const runtime = new ThreeRuntime({ canvas });
runtime.setTransformMode("rotate"); // remembered until the addon mounts
```

**Animation.** Clips from `LoadedAsset.animations` are bound to each mounted asset instance (one mixer per object). One *object* plays at a time across the runtime; within it, several clips can share the mixer with weights (`playAnimationBlend`) — glTF's own model is one skeleton driven by N concurrent samplers.

| Member | Description |
|---|---|
| `animations` | `AnimationClipInfo[]`: `{ id: "objectId#index", objectId, index, name, duration }` |
| `playAnimation(objectId?, index?)` | Start a clip (`null` objectId = first object with clips); starts an rAF loop |
| `pauseAnimations()` / `resumeAnimations()` | Pause without rewind / continue from the playhead |
| `setAnimationSpeed(speed)` | Playback rate (`0` allowed) |
| `setAnimationTime(seconds)` | Scrub the active clip (every layer of a blend) |
| `playAnimationBlend(layers, objectId?)` | `AnimationBlendLayer[]` = `{ index, weight, timeScale? }`; weights are normalized, so `[1, 1]` is 50/50. A single layer is exactly `playAnimation` |
| `animationBlend` | Live layers, heaviest first: `{ index, weight, timeScale }[]` |
| `animationPlaying` / `animationTime` / `animationDuration` | Transport read surface (they follow the heaviest layer) |

```ts
const runtime = new ThreeRuntime({ canvas, assetCache });
await runtime.loadDocument(doc); // assets with clips register their mixers
runtime.playAnimation("obj-1", 0);
```

### Viewer rigs

`ThreeRuntime` is a thin orchestrator over these composable pieces (same split a standalone glTF viewer uses). Import them from `@scenio/scene-editor/three` to build a viewer without the editor contract.

| Export | Responsibility |
|---|---|
| `createCameraRig` | Camera + OrbitControls lifecycle, `readView()` / `applyView()` / `easeTo()` / `finishEase()`, `applyControls()` (limits/verbs/sensitivity), `setAutoRotate()`, `resetTurntableRotation()`, and `touch-action` ownership (held against both canvas addons) |
| `createLightingRig` | Ambient + directional lights, view read/apply |
| `createEnvironmentRig` | Background + floor grid |
| `createObjectStore` | id → Object3D registry, asset instantiation, disposal |
| `createGizmoRig` | TransformControls mount / mode / selection binding |
| `createAnimationRig` | glTF clips, mixers, transport |
| `createDisplayRig` | Viewport shading (`display-mode`): shared override material per mode, document meshes + batch chunks, exact restore on `studio` |
| `createExplodeRig` | Component explode (`explode`): document positions as baseline, writes through `applyTransform` so batched instances follow |
| `createRenderLoop` | Single re-entrancy-guarded render entry |

**WebGPU opt-in:** construct a `WebGPURenderer`, `await renderer.init()` **before** constructing the runtime (constructor renders once), pass `rendererFactory: () => renderer`. Detect silent fallback via `renderer.backend.isWebGPUBackend === true`. This seam is the only supported WebGPU path; WebGL2 remains the default and the CI-tested renderer.

### Renderer

| Export | Description |
|---|---|
| `createRenderer(canvas, options?)` | Single creation site for WebGLRenderer; failures → `SceneEditorError("render-init-failed")`. Options: `antialias` (default true), `maxPixelRatio` (default 2), `alpha` (default **true** — a `null` scene background shows the page through the canvas) |
| `RendererHandle` | Structural slice: `render`, `setSize`, `setPixelRatio`, `dispose` |
| `CreateRendererOptions` | type above |

### Transform controls binding

| Export | Description |
|---|---|
| `createTransformControlsBinding(options)` | Wraps three `TransformControls`; one drag → one `transform-commit` event |
| `TransformControlsBinding` / `TransformControlsBindingOptions` / `TransformControlsLike` / `TransformSnapshot` | Supporting types |

### Document export

| Export | Description |
|---|---|
| `exportDocumentBlob(doc, source, format?)` | `doc` + anything with `getObjectById(id)` → `Blob`. `glb` (default), `gltf`, `obj`; exporters are imported on demand |
| `createDocumentGroup(doc, source)` | The step that makes it correct: one detached `Group` of clones with the **stored** transforms written back, so preview offsets and preview materials cannot leak. Shares geometry/materials with the originals — throw the group away, never dispose it |
| `exportGroupBlob(group, format)` | Serialize a group you built yourself (`Group` → `Blob`) |
| `sanitizeName(value, fallback)` | `sceneId` → file-name-safe stem |
| `DocumentExportFormat` / `DocumentObjectSource` | Types |

### Picking

| Export | Description |
|---|---|
| `createPicker(options)` | Raycast helper. `setTargets(objects)`, `pick(clientX, clientY) => id \| null`, `pickDetail()` for point+normal |
| `Picker` / `PickerOptions` / `RaycastHit` | Types; `PickerOptions.raycast` injects a stub for tests, `bvhThreshold` sets the triangle count above which a mesh gets a BVH (default 2 000) |
| `Picker.ready()` | Resolves after the BVH chunk and trees are in place; await it to make the *first* pick fast. `Picker.accelerated` counts accelerated meshes (diagnostics/tests) |

Meshes above `bvhThreshold` triangles are raycast through a `MeshBVH` (`three-mesh-bvh`), with the mesh's own `raycast` swapped for `acceleratedRaycast` — never the `THREE.Mesh.prototype`, since an SDK must not patch a peer dependency globally. The BVH is a **dynamic import** and only requested when the mounted content actually contains a mesh above the threshold, so a viewer of primitives never downloads it (~33 kB gzip). Measured on a 130 560-triangle mesh: **12.0 ms → 0.10 ms** per pick, with a one-off ~63 ms tree build. Trees are shared per geometry (asset instances clone the same buffers) and reference-counted, so disposing one picker cannot detach another's; skinned, morphed and instanced meshes stay on three's own path.

### Object factory

| Export | Description |
|---|---|
| `createPrimitiveGeometry(geometry)` | Document `PrimitiveGeometry` → `THREE.BufferGeometry`; documented defaults fill every omitted parameter |
| `createPrimitiveObject(dto)` | `PlaceholderObject` (`{ object, dispose }`) for a `primitive` DTO; material override applied |
| `applyMaterialFields(material, dto)` | Writes only the declared fields; derives `transparent` / `depthWrite` from `opacity`; unsupported parameters (e.g. `metalness` on an unlit material) are skipped |
| `applyMaterialOverride(object, dto)` | Walks a subtree, **clones** each mesh material before writing, returns the clones for the caller to dispose. Cloning is required: `Object3D.clone()` shares materials with the cached asset |
| `PlaceholderObject` | type: `{ object: THREE.Mesh; dispose: () => void }` |

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
- `apps/playground/src/viewer/viewer-controller.ts` — viewer state → engine updates (display / explode route to the SDK rigs, environment, animation)
- `apps/playground/src/ui/studio-shell.ts` — composes HUD panels, hotkeys
- `apps/playground/src/ui/scene-export.ts` — GLB/OBJ export (document state, not preview) + PNG snapshot
