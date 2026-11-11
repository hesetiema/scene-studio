# @scenio/scene-editor

Embeddable 3D scene editor and model viewer for the web. One `<scene-editor>` element, two shapes:
point it at a `src` and it is a **viewer** — configured entirely with attributes, no page-level
JavaScript; give it a document with `loadDocument()` and it is an **editor** with selection,
transform gizmos, undo/redo and a host-owned save flow. Both share one document model and one
runtime contract, so a viewer can grow into an editor without a rewrite.

**Status:** `0.7.0` alpha (unreleased); npm `latest` is `0.6.0`. The API may still adjust before
`1.0.0`; after that, semver applies. `three` is a peer dependency you install yourself.

> Package scope (`@scenio`) is a placeholder until the npm org name is chosen.

Repository: <https://github.com/hesetiema/scene-studio> · Issues: <https://github.com/hesetiema/scene-studio/issues>

**Docs:** English (this page) · [简体中文](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.zh-CN.md) · [API reference](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/API.md) · [Architecture & benchmarks](https://github.com/hesetiema/scene-studio/blob/main/docs/ARCHITECTURE.md)

## Install

Run `npm install @scenio/scene-editor three` (or `pnpm add @scenio/scene-editor three`); `three@^0.186.0`
is a peer dependency. Register the element **once** in your app entry with
`import { defineSceneEditor } from "@scenio/scene-editor/element"; defineSceneEditor();` — idempotent
and SSR-safe. After that, everything below is declarative HTML or ordinary DOM code.

The package ships **no CSS**. `<scene-editor>` is an unstyled custom element, so give it a block
box and a size yourself — `scene-editor { display: block; height: 480px }`, or the inline `style`
used in the two examples below. The element positions its own canvas, poster and slots; everything
outside that box is host styling.

## 1. Viewer — attributes only, no JavaScript

`src` synthesizes a one-mesh document, frames the camera the way `<model-viewer>` does, and reports
`progress` → `load` → `error`. A preview is always `mode="viewer"`: no grid, no transform gizmo, no
click-to-select, no editor keystrokes. Every viewer-side switch is an attribute, and **none of them
writes to the document**.

```html
<scene-editor
  src="/models/robot.glb"
  style="display: block; width: 100%; height: 480px"
  loading="lazy"
  auto-rotate
  camera-orbit="0deg 75deg 2m"
  field-of-view="auto"
  environment-image="neutral"
  tone-mapping="neutral"
  shadow-intensity="0.8"
  autoplay
  reveal="interaction"
  alt="Robot"
>
  <img slot="poster" src="/poster.jpg" alt="" />
  <div slot="progress-bar">Loading…</div>
  <div slot="error">Could not load the model</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">Lens</button>
</scene-editor>
```

`src` is read **once, when the element connects**. Put it in the markup (or set it before
connection); changing it afterwards has no effect — replace the element to show another model, or
call `loadDocument()` when the host owns the document.

| Group | Attributes |
|---|---|
| Mode | `mode` (`viewer` \| `editor`) — absent means derived: `src` → viewer, `loadDocument()` → editor. The effective value is mirrored to `data-mode` |
| Loading | `src`, `loading="lazy"`, `with-credentials`, `reveal` (`auto`/`interaction`/`manual`), `seamless-poster`, `decoder-path`, `decoder-cdn` |
| Camera | `camera-orbit`, `camera-target`, `field-of-view`, `min/max-field-of-view`, `min/max-camera-orbit`, `camera-damping`, `interpolation-decay` |
| Rotation | `auto-rotate`, `rotation-per-second`, `auto-rotate-delay` |
| Input | `disable-pan`, `disable-zoom`, `disable-tap`, `orbit-sensitivity`, `zoom-sensitivity`, `pan-sensitivity`, `touch-action` |
| Look | `tone-mapping`, `exposure`, `display-mode` (`studio`/`xray`/`wireframe`/`normal`/`clay`), `explode` (`0..1`), `environment-image`, `skybox-image`, `shadow-intensity`, `shadow-softness` |
| Content | `variant-name`, `camera-name`, `animation-name`, `animation-crossfade-duration`, `autoplay`, `pause-at-end` |
| A11y | `alt` (mirrored to the canvas `aria-label`) |

The canvas is transparent by default, so a `null` background shows the page through. `load` fires
**after** framing, so `getDimensions()` in a `load` callback already sees the final camera and size.
A failure paints `slot="error"` (or a built-in message when the slot is absent) instead of leaving a
blank rectangle — Draco / KTX2 / Meshopt are assembled lazily once `decoder-path` or `decoder-cdn`
is set. `display-mode` and `explode` are pure viewport overlays: they never reach an export.
`alt`, `slot="poster"`, `slot="progress-bar"`, `slot="error"` and `slot="hotspot-*"` are the viewer
chrome; their names follow model-viewer.

## 2. Editor — a real host integration

The host owns the document, the backend and the buttons. The SDK never talks to your API: it emits
`save-request` and waits for `markSaved(revision)`. This is the whole integration — load a scene from
your own endpoint, wire three buttons, persist, and surface failures.

```html
<scene-editor id="editor" style="display: block; width: 100%; height: 600px"></scene-editor>
<button id="undo" disabled>Undo</button>
<button id="redo" disabled>Redo</button>
<button id="save" disabled>Save</button>
<p id="status" role="status"></p>

<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";

  defineSceneEditor(); // idempotent, SSR-safe

  const el = document.querySelector("#editor");
  const status = document.querySelector("#status");
  const undoBtn = document.querySelector("#undo");
  const redoBtn = document.querySelector("#redo");
  const saveBtn = document.querySelector("#save");

  // Your backend owns the document. loadDocument() validates schema v3
  // (v1/v2 migrate automatically) and flips this element into editor mode.
  const response = await fetch("/api/scenes/42");
  if (!response.ok) throw new Error(`scene load failed: ${response.status}`);
  await el.ready;
  await el.loadDocument(await response.json());

  // The SDK only asks to persist — it never fetches, retries or merges.
  el.addEventListener("save-request", async ({ detail }) => {
    const res = await fetch(`/api/scenes/${detail.document.sceneId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(detail.document),
    });
    if (!res.ok) {
      status.textContent = `Save failed (${res.status}) — your edits are still here`;
      return; // no markSaved → stays dirty, Save stays enabled
    }
    const { revision } = await res.json();
    el.markSaved(revision); // clears dirty, adopts the server revision
  });

  el.addEventListener("history-change", ({ detail }) => {
    undoBtn.disabled = !detail.canUndo;
    redoBtn.disabled = !detail.canRedo;
    saveBtn.disabled = !detail.dirty;
  });
  el.addEventListener("document-dirty", ({ detail }) => {
    saveBtn.disabled = !detail.dirty; // view edits are dirty but not undoable
  });
  el.addEventListener("error", ({ detail }) => {
    status.textContent = `${detail.code}: ${detail.message}`;
  });

  undoBtn.addEventListener("click", () => el.undo());
  redoBtn.addEventListener("click", () => el.redo());
  saveBtn.addEventListener("click", () => el.requestSave());
</script>
```

That is what a user sees: drag to orbit, wheel to zoom, click to select (`Shift`/`Ctrl`/`Cmd`+click
toggles multi-select), drag the gizmo to transform, `Ctrl+Z` / `Ctrl+Shift+Z` with focus inside the
element. Adding `mode="viewer"` to the same document gives a read-only viewport — how you show a
saved scene without an editor around it.

If your backend does not store a full scene document yet, build one with `createSceneDocument()` (or
`createDocumentFromAsset()` for a single model) from the core entry instead of hand-writing the
six-field envelope; `parseSceneDocument()` runs the same validation server-side.

### Save & conflict

1. User edits → `dirty: true` → your UI enables Save.
2. `el.requestSave()` (or a `save-request` from elsewhere) → PUT `detail.document` to your API.
3. On success call `el.markSaved(serverRevision)`; dirty clears, revision adopts the server value.
4. On a revision mismatch your server rejects; surface the structured conflict (`base` / `incoming`
   / `local`) and let the user resolve. The SDK never auto-merges. `applyRemote()` follows the same
   rule for inbound updates.

### Events

All are `CustomEvent`s on the element; none bubble or compose.

| Event | Detail | Fired when |
|---|---|---|
| `scene-ready` | — | Init finished; canvas + runtime live |
| `progress` | `{ totalProgress, reason }` | Load progress, monotonic 0..1 |
| `load` | `{ sceneId, url }` | Content mounted and framed |
| `selection-change` | `{ ids }` | Selection changed |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | Command executed / undo / redo |
| `document-dirty` | `{ dirty }` | Dirty flag crossed false↔true |
| `save-request` | `{ reason, document, revision }` | Host should persist |
| `view-change` | `{ view, source }` | Settled viewport view (`interaction`/`api`/`load`) |
| `view-changing` | `{ view }` | In-flight camera sample — opt in with `live-view-events` |
| `camera-change` | `{ position, target, fov }` | Camera moved; always on |
| `environment-change` | `{ environment, source }` | Background / grid / IBL / HDR / shadow changed |
| `model-visibility` | `{ visible }` | `loaded × in-viewport × poster dismissed` |
| `visibility-change` | `{ visible }` | Element entered/left the viewport |
| `play` / `pause` / `loop` / `finished` | transport payloads | Clip started, stopped, wrapped, ended |
| `error` | `{ code, message, cause? }` | Any SDK failure — the reliable failure channel |

Persist on `view-change`; `view-changing` is for live consumers (remote camera sync, recording, HUD).

### Document model

A scene is plain JSON validated with zod; nothing GPU-specific is persisted. The six top-level fields
are `schemaVersion` (3), `sceneId`, `revision`, `objects`, `view` (and nothing else). `objects` may
be `mesh`, `group` or `primitive` (eight procedural shapes), carry `assetId`, `parentId`, a partial
`material` override, `position` / `rotation` / `scale` and `metadata`. `view` holds `camera`,
`lights` (ambient + directional + optional additional lights) and `environment` (background, grid,
IBL intensity). `parentId` builds real three.js parenting — a child with a missing parent is promoted
to a root, cycles are broken. Object writes (`addObject` / `removeObject` / `reparent` /
`setMaterial`) are undoable and validated against the same hierarchy rules used on load; consecutive
writes to one object merge into one undo step. View edits mark the document dirty but are not
undoable. Full field-level signatures are in [API.md](API.md#document-schema-zod).

### The rest, in brief

- **Assets.** Objects reference `assetId`, never URLs; your `el.assetResolver` maps ids to URLs and
  is your trust boundary — allowlist ids. `AssetCache` refcounts per id, so parallel loads collapse
  and disposal happens when the last reference drops. Formats: `.glb` / `.gltf`, with Draco / KTX2 /
  Meshopt assembled lazily via `decoder-path` or `decoder-cdn`.
- **Upload / export / snapshot.** `el.loadFiles(files)` reuses the `src` progress / framing / error
  path (a `.gltf` sidecar bundle is rewritten to blob URLs); `el.exportDocument({ format })` exports
  **document** transforms by default for `glb` / `gltf` / `obj`, so preview offsets never leak;
  `el.toBlob()` plus `downloadBlob()` handles snapshots. `LIGHTING_PRESETS` ships reference lighting
  as data.
- **Headless.** `createSceneEditor({ runtime: new FakeRuntime() })` from the core entry runs the same
  document / history / selection / save pipeline with no DOM — bring your own UI, commands
  (`executeCommand()`) and key map (`handleKeyDown()`).
- **Plugins.** Plain `{ id, install(context) }` objects; `install` receives `runtime`, `editor`,
  `on(type, handler)` and `addDisposer(fn)`. `el.use(plugin)` / `el.unuse(id)`.
- **WebGPU.** Default renderer is WebGL2; opt in through `SceneEditorElement.runtimeFactory` and
  `await renderer.init()` before returning a `ThreeRuntime`.
- **Errors.** Switch on `code`, never on messages. `SceneErrorCode`: `validation`,
  `asset-resolve-failed`, `asset-load-failed`, `render-init-failed`, `lifecycle`, `conflict`.
  `AssetErrorCode`: `asset-not-found`, `asset-resolve-failed`, `asset-load-failed`,
  `asset-unsupported-format`, `asset-disposed`.

### Entry points

| Import | What you get | When to use |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` + `defineSceneEditor()` | Most integrations — viewer **and** editor |
| `@scenio/scene-editor` | `createSceneEditor()`, schema, commands, errors, assets, plugin types | Headless editing, custom runtimes, server-side validation |
| `@scenio/scene-editor/three` | `ThreeRuntime` + composable viewer rigs, picker, control bindings | Custom renderer or custom scene-graph wiring |

### Compatibility

| Axis | Supported | How verified |
|---|---|---|
| `three` | `^0.186.0` (peer) | CI matrix pins `0.186.0` + `latest` within the range |
| Renderer | WebGL2 (default), WebGPU via `rendererFactory` | WebGL2 CI-tested; WebGPU opt-in, host-owned |
| Formats | `.glb`, `.gltf` | Unit tests + e2e; Draco/KTX2 optional inject |
| Browsers | Anything with WebGL2 + ES modules | Playwright e2e (Chromium in CI) |
| Module | ESM only | `npm pack` consumption test |
| SSR | Element is lazy — `defineSceneEditor()` at runtime | Core entry has no DOM side effects |

A red `latest` leg on a new `three` minor is the intended early warning for the peer range.

## Development (monorepo)

From the repository root: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`,
`pnpm test:release`, `pnpm test:pack`. The reference host lives in `apps/playground`.

## License

MIT — see [LICENSE](LICENSE).
