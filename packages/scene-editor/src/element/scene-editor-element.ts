import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  DisplayModeId,
  EnvironmentPreset,
  RuntimeContract,
  Transform,
} from "../runtime/runtime-contract";
import type {
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";
import { ThreeRuntime } from "../three/three-runtime";
import type { SceneEditorPlugin } from "../plugins/plugin";
import type { AssetResolver } from "../assets/resolver-asset-loader";
import type { MorphTargetInfo } from "../runtime/runtime-contract";
import { createResolverAssetLoader } from "../assets/resolver-asset-loader";
import { AssetCache } from "../assets/asset-cache";
import type {
  GltfDecoders,
  MinimalGltfLoader,
} from "../assets/gltf-asset-loader";
import { applyGltfDecoders } from "../assets/gltf-asset-loader";
import {
  createLazyDecoders,
  DEFAULT_DECODER_CDN,
  type LazyDecoderBundle,
  type LazyDecoderOptions,
} from "../assets/lazy-decoders";
import type { Command } from "../core/history/command-history";
import {
  createSceneEditor,
  type SceneEditor,
  type SceneEditorElementEventMap,
} from "../runtime/create-scene-editor";
import { createSrcDocument, SRC_ASSET_ID } from "./src-document";
import { createDocumentFromAsset } from "../core/document/create";
import { createPreviewViewState } from "../core/document/default-view";
import { createFileBundleUrl, type FileBundle } from "../assets/file-bundle";
// Element-internal layering, bottom up: math → slot chrome / attributes.
import {
  cameraFromOrbit,
  orbitFromCamera,
  type CameraOrbit,
} from "./attribute-math";
import { SlotChrome, type HotspotConfig, type HotspotData } from "./slot-chrome";
import { ViewerAttributes, displayModeFrom, explodeFrom } from "./viewer-attributes";

// The hotspot vocabulary lives next to the code that produces it; it is still
// exported from this module because `element-entry.ts` re-exports it from here.
export type { HotspotConfig, HotspotData, HotspotVector } from "./slot-chrome";
// Camera vocabulary now lives next to the orbit math; still reachable from here.
export type { CameraOrbit } from "./attribute-math";

/** Options for {@link SceneEditorElement.exportDocument}. */
export interface SceneExportOptions {
  /** `glb` (default), `gltf` (JSON) or `obj`. */
  format?: "glb" | "gltf" | "obj";
}

export interface RuntimeFactoryOptions {
  /** Host asset resolver (design §10); default factory builds an AssetCache from it. */
  assetResolver?: AssetResolver;
  /** Built-in studio IBL, derived from `environment-image` (default `"room"`). */
  environmentPreset?: EnvironmentPreset;
  /**
   * Authoring chrome on/off, derived from `mode` (default: viewer for `src`,
   * editor for a host document). The default factory forwards it to the
   * runtime's `interactive` option; a custom factory should do the same, or it
   * will show a gizmo inside a read-only viewer.
   */
  interactive?: boolean;
  /**
   * Decoder bundle, read before every asset load. The default factory forwards
   * it to the glTF loader; a custom factory should do the same so the element's
   * `dracoLoader` / `ktx2Loader` / `meshoptDecoder` properties keep working.
   */
  getDecoders?: () => GltfDecoders;
  /**
   * `with-credentials`, read before every asset load: model-viewer's switch for
   * fetching the model (and its external buffers/textures) with cookies and
   * authorization headers. The default factory forwards it to the glTF loader.
   */
  getWithCredentials?: () => boolean;
  /**
   * Draw-call batching, derived from `instancing` (default on). The default
   * factory forwards it to the runtime's `instancing` option; a custom factory
   * may ignore it, in which case the element's follow-up `setInstancing()` call
   * still applies it.
   */
  instancing?: boolean;
}

export type SceneEditorRuntimeFactory = (
  canvas: HTMLCanvasElement,
  options?: RuntimeFactoryOptions,
) => RuntimeContract;

/**
 * GLTFLoader is code-split so element-entry stays lean; loadAsync resolves on
 * first use. Decoder setters are recorded and pushed onto the real loader both
 * at construction and before each load, so the host may assign them at any
 * point before the first asset request.
 */
function lazyGltfLoader(): MinimalGltfLoader {
  type Loader = import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader;
  let pending: Promise<Loader> | null = null;
  const decoders: GltfDecoders = {};
  const push = (loader: Loader): void =>
    applyGltfDecoders(loader as unknown as MinimalGltfLoader, decoders);
  const load = (): Promise<Loader> =>
    (pending ??= import("three/examples/jsm/loaders/GLTFLoader.js").then((m) => {
      const loader = new m.GLTFLoader();
      push(loader);
      return loader;
    }));
  return {
    loadAsync: async (url) => {
      const loader = await load();
      push(loader);
      return loader.loadAsync(url);
    },
    setDRACOLoader: (value) => {
      decoders.dracoLoader = value;
    },
    setKTX2Loader: (value) => {
      decoders.ktx2Loader = value;
    },
    setMeshoptDecoder: (value) => {
      decoders.meshoptDecoder = value;
    },
  };
}

/** Keyboard capture list (D20) — documented for hosts. */
export const CAPTURED_COMBOS = ["ctrl+z", "ctrl+shift+z", "ctrl+y", "g", "r", "s"] as const;

/** The slice of `IntersectionObserver` the element needs (SSR/happy-dom may lack it). */
export interface VisibilityObserver {
  observe(target: Element): void;
  disconnect(): void;
}

/** Injectable seam for `visibility-change`; return `null` to disable the event. */
export type VisibilityObserverFactory = (
  onChange: (visible: boolean) => void,
) => VisibilityObserver | null;

/** Attributes that only steer the orbit controls (never persisted, never dirty). */
const CAMERA_ATTRIBUTES: ReadonlySet<string> = new Set([
  "auto-rotate",
  "auto-rotate-delay",
  "rotation-per-second",
  "min-camera-orbit",
  "max-camera-orbit",
  "disable-pan",
  "disable-zoom",
  "camera-damping",
]);

/**
 * Pointer routing, model-viewer's interaction surface: `orbit-sensitivity`
 * scales the drag (negative inverts it), `zoom-sensitivity` / `pan-sensitivity`
 * do the same for the wheel and the two-finger pan, and `touch-action` tells the
 * browser which gestures stay its own — a viewer embedded in a long page must
 * not hijack vertical scroll.
 */
const INTERACTION_ATTRIBUTES: ReadonlySet<string> = new Set([
  "orbit-sensitivity",
  "zoom-sensitivity",
  "pan-sensitivity",
  "touch-action",
]);

/** The three pointer-speed multipliers, all fed to `#applyCameraSettings`. */
const SENSITIVITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "orbit-sensitivity",
  "zoom-sensitivity",
  "pan-sensitivity",
]);

/** Attributes that only steer animation playback (viewer chrome, not the document). */
const PLAYBACK_ATTRIBUTES: ReadonlySet<string> = new Set([
  "autoplay",
  "animation-name",
  "animation-crossfade-duration",
  "pause-at-end",
]);

/** Presentation-only knobs; never written to the document (contrast: view state). */
const DISPLAY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "tone-mapping",
  "exposure",
  "display-mode",
  "explode",
  "shadow-intensity",
  "shadow-softness",
  "variant-name",
  "camera-name",
]);

/**
 * Loading-pipeline knobs (`decoder-path` / `decoder-cdn`). Changing one rebuilds
 * the decoder bundle; the effect lands on the next load, since a fetch already
 * in flight owns its decoders.
 */
const DECODER_ATTRIBUTES: ReadonlySet<string> = new Set(["decoder-path", "decoder-cdn"]);

/**
 * Renderer-strategy knobs (`instancing`). Unlike the decoder pair these take
 * effect immediately: batching is a draw-time detail, so flipping it never
 * touches the document and never needs a reload.
 */
const RENDER_ATTRIBUTES: ReadonlySet<string> = new Set(["instancing"]);

/**
 * Read `instancing` as a flag, defaulting to **on**.
 *
 * Tri-state on purpose: absent means "batch", and a bare `<scene-editor
 * instancing>` must not silently mean the opposite of the default — that is the
 * kind of attribute that only shows up in a bug report. `false` / `0` / `off` /
 * `no` are the spellings hosts actually write.
 */
function instancingFrom(value: string | null): boolean {
  if (value === null) return true;
  const normalized = value.trim().toLowerCase();
  return !(
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off" ||
    normalized === "no"
  );
}

/**
 * Camera pose attributes — model-viewer's `camera-orbit` / `camera-target` /
 * `field-of-view`, plus their clamp pair.
 *
 * Display-only for the same reason as `environment-image`: they describe how a
 * host wants to *look at* the content, not what the document contains, so they
 * must not dirty the scene. They are re-asserted after every load (a document's
 * own `view` lands after the `load` event), which is why the applied signature
 * is remembered instead of the values.
 */
const VIEW_ATTRIBUTES: ReadonlySet<string> = new Set([
  "camera-orbit",
  "camera-target",
  "field-of-view",
  "min-field-of-view",
  "max-field-of-view",
]);

/** `<scene-editor mode="viewer">` vs `mode="editor"` (see `SceneEditorElement.mode`). */
export type SceneEditorMode = "viewer" | "editor";

/**
 * Thin DOM shell (0.2): owns the canvas, viewport wiring (click-select, resize,
 * keyboard focus domain) and CustomEvent bridging. All editing logic lives in
 * the headless facade (`createSceneEditor`), so element and headless hosts share
 * one implementation of documents, history, selection, plugins and key semantics.
 */
export class SceneEditorElement extends HTMLElement {
  /** Injectable seam for tests; defaults to real ThreeRuntime (D1). */
  static runtimeFactory: SceneEditorRuntimeFactory = (canvas, options) => {
    const assetCache = options?.assetResolver
      ? new AssetCache(
          createResolverAssetLoader({
            resolver: options.assetResolver,
            gltfLoader: lazyGltfLoader(),
            ...(options.getDecoders ? { decoders: options.getDecoders } : {}),
            ...(options.getWithCredentials
              ? { withCredentials: options.getWithCredentials }
              : {}),
          }),
        )
      : undefined;
    return new ThreeRuntime({
      canvas,
      ...(assetCache ? { assetCache } : {}),
      ...(options?.environmentPreset ? { environmentPreset: options.environmentPreset } : {}),
      ...(options?.interactive === undefined ? {} : { interactive: options.interactive }),
      ...(options?.instancing === undefined ? {} : { instancing: options.instancing }),
    });
  };

  /**
   * Injectable seam for `decoder-path` / `decoder-cdn`. Defaults to the lazy
   * three decoders; tests (and hosts that pre-stage payloads, e.g. inside a
   * service worker cache) can swap it.
   */
  static decoderBundleFactory: (options: LazyDecoderOptions) => LazyDecoderBundle =
    createLazyDecoders;

  /**
   * Injectable seam for `visibility-change`. Defaults to IntersectionObserver
   * when the platform provides one; returning `null` disables the event.
   */
  static visibilityObserverFactory: VisibilityObserverFactory = (onChange) => {
    if (typeof IntersectionObserver === "undefined") return null;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) onChange(last.isIntersecting);
    });
    return {
      observe: (target) => observer.observe(target),
      disconnect: () => observer.disconnect(),
    };
  };

  /**
   * Observed knobs, all viewer-side (never written to the document):
   * `live-view-events` (opt-in sampling), `src` / `loading` / `reveal`
   * (declarative preview + poster), `tone-mapping` / `exposure` /
   * `environment-image` (display), the camera policy set
   * (`auto-rotate`, `min/max-camera-orbit`, `disable-pan`, `disable-zoom`) and
   * the animation transport set (`autoplay`, `animation-name`,
   * `animation-crossfade-duration`, `pause-at-end`).
   */
  static get observedAttributes(): string[] {
    return [
      "live-view-events",
      "mode",
      "src",
      "loading",
      "reveal",
      "environment-image",
      "skybox-image",
      "tone-mapping",
      "exposure",
      "display-mode",
      "explode",
      "shadow-intensity",
      "shadow-softness",
      "variant-name",
      "camera-name",
      "seamless-poster",
      "alt",
      "decoder-path",
      "decoder-cdn",
      "instancing",
      ...VIEW_ATTRIBUTES,
      ...CAMERA_ATTRIBUTES,
      ...INTERACTION_ATTRIBUTES,
      ...PLAYBACK_ATTRIBUTES,
    ];
  }

  /** Host-provided asset resolution — set before connect/ready. */
  assetResolver: AssetResolver | null = null;

  /**
   * Optional decoders (D16). Assign the instance, not a path — three wants a
   * constructed `DRACOLoader` / `KTX2Loader` (the latter must already have
   * `detectSupport(renderer)` called). Read before every asset load, so these
   * may be set before `connect` or between `loadDocument()` / `loadFiles()` calls.
   *
   * ```js
   * // <scene-editor src="/compressed.glb"></scene-editor> — declared in markup
   * const ktx2 = new KTX2Loader().setTranscoderPath("/basis/");
   * el.dracoLoader = new DRACOLoader().setDecoderPath("/draco/");
   * el.ktx2Loader = ktx2;
   * ```
   */
  get dracoLoader(): unknown {
    return this.#dracoLoader;
  }
  set dracoLoader(value: unknown) {
    this.#dracoLoader = value ?? null;
  }
  get ktx2Loader(): unknown {
    return this.#ktx2Loader;
  }
  set ktx2Loader(value: unknown) {
    this.#ktx2Loader = value ?? null;
  }
  get meshoptDecoder(): unknown {
    return this.#meshoptDecoder;
  }
  set meshoptDecoder(value: unknown) {
    this.#meshoptDecoder = value ?? null;
  }

  /**
   * Preview source (`glb` / `gltf`), read once when the element initializes.
   *
   * **Declarative only.** Put it in the markup, or set it before the element
   * connects. A change after initialization is ignored with a one-time warning:
   * re-loading through a second attribute value used a racy GLTF path that
   * could hang without dispatching `load` or `error`. To show another model,
   * replace the element, or call `loadDocument()` for a host-owned document.
   * When present and the host has not called `loadDocument()`, the element
   * synthesizes a one-mesh document for it.
   */
  get src(): string | null {
    const value = this.getAttribute("src");
    return value ? value : null;
  }

  set src(value: string | null) {
    if (value) this.setAttribute("src", value);
    else this.removeAttribute("src");
  }

  /**
   * What the element is: a **viewer** renders the model (orbit, zoom, hotspots,
   * animation) and owns no authoring chrome; an **editor** adds the selection
   * gizmo and click-to-select.
   *
   * `mode="viewer|editor"` forces it. Without the attribute the mode follows the
   * document owner — a declarative `src` preview is a viewer, a host
   * `loadDocument()` is an editor — which is what keeps `<scene-editor src>` a
   * drop-in model viewer without asking hosts to opt out of a gizmo.
   *
   * The effective value is mirrored to `data-mode` for CSS, and pushed to the
   * runtime's `setInteractive()`.
   */
  get mode(): SceneEditorMode {
    const raw = (this.getAttribute("mode") ?? "").trim().toLowerCase();
    if (raw === "viewer" || raw === "editor") return raw;
    // Both declarative previews (`src`, `loadFiles`) are viewers: the host did
    // not hand us a document, so there is nothing to author yet.
    const preview = (this.src !== null || this.#fileAssetId !== null) && this.#documentOwner !== "host";
    return preview ? "viewer" : "editor";
  }

  set mode(value: SceneEditorMode) {
    this.setAttribute("mode", value);
  }

  /**
   * Draw-call batching (default `true`).
   *
   * Repeated primitives — same geometry parameters, same material — are drawn
   * as `InstancedMesh` chunks, so 5 000 identical boxes cost tens of draw calls
   * instead of thousands. The document is untouched: every object keeps its id,
   * transform, material and pick box, which is why this is a *renderer* switch
   * and not a document one.
   *
   * `instancing="false"` is the escape hatch for hosts that inspect the scene
   * graph and expect one visible mesh per object (a screenshot service, a
   * custom exporter, a debug overlay counting `scene.traverse` hits).
   */
  get instancing(): boolean {
    return instancingFrom(this.getAttribute("instancing"));
  }

  set instancing(value: boolean) {
    this.setAttribute("instancing", value ? "true" : "false");
  }

  /**
   * Viewport shading (`display-mode`): `studio` (default) / `xray` /
   * `wireframe` / `normal` / `clay`. Presentation only — the document's
   * materials are untouched, and batched instances are covered too.
   */
  get displayMode(): DisplayModeId {
    return displayModeFrom(this.getAttribute("display-mode")) ?? "studio";
  }

  set displayMode(value: DisplayModeId) {
    this.setAttribute("display-mode", value);
  }

  /**
   * Component explode (`explode`, 0..1). A runtime-only preview: object
   * positions in the document stay the baseline, so 0 restores exactly.
   */
  get explode(): number {
    return explodeFrom(this.getAttribute("explode"));
  }

  set explode(value: number) {
    if (!Number.isFinite(value)) return;
    this.setAttribute("explode", String(Math.min(1, Math.max(0, value))));
  }

  #editor: SceneEditor | null = null;
  #dracoLoader: unknown = null;
  #ktx2Loader: unknown = null;
  #meshoptDecoder: unknown = null;
  /**
   * Decoders assembled from `decoder-path` / `decoder-cdn`. `null` when neither
   * attribute is set — the default stays "no decoders, no extra requests".
   */
  #decoders: LazyDecoderBundle | null = null;
  #visibilityObserver: VisibilityObserver | null = null;
  #intersectionVisible = false;
  /** Element scrolled out of view → the runtime stops drawing. */
  #visibilityPaused = false;
  /** Background tab → same pause, set from `visibilitychange`. */
  #tabHidden = false;
  /** Last value pushed to the runtime, so both sources de-duplicate to one call. */
  #renderPaused = false;
  #liveViewEvents = false;
  /** `loading="lazy"` deferred the initial `src` load until first visibility. */
  #deferredSrcLoad = false;
  /**
   * The current preview produced an `error`. A `src` document is a single
   * asset, so a failed one leaves nothing to frame or announce.
   */
  #srcLoadFailed = false;
  /** Who owns the document: declarative `src` or an explicit `loadDocument()`. */
  #documentOwner: "host" | "src" | null = null;
  /** One-time warning when a host changes `src` after initialization. */
  #warnedSrcChange = false;
  /** Last mode pushed to the runtime; `null` until a runtime exists. */
  #appliedMode: SceneEditorMode | null = null;
  #ready!: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (err: unknown) => void;
  #abort: AbortController | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #wasDisconnected = false;
  readonly #pendingPlugins: SceneEditorPlugin[] = [];

  /* ------------------------------------------------------------- slots ---- */
  /**
   * Light-DOM slot chrome: poster, progress bar, error surface and hotspot
   * anchors. It owns the styling and the reveal state; this element owns the
   * runtime and the events, so the two stay separable.
   */
  readonly #slots = new SlotChrome({
    element: this,
    runtime: () => this.#editor?.runtime ?? null,
    onSlotStateChange: () => this.#syncModelVisibility(),
  });

  /* ---------------------------------------------------- viewer attributes ---- */
  /**
   * Attribute → runtime projection: environment, alt, display, shadow, camera
   * pose and policy, playback, `touch-action`. It owns the "what does this
   * attribute mean" half; this element owns the "when" half (connect, load,
   * attribute change) and the public API those attributes feed.
   *
   * The five callbacks are read at call time, so building it here — before
   * `#editor` or `#canvas` exist — is safe.
   */
  readonly #attrs = new ViewerAttributes({
    element: this,
    runtime: () => this.#editor?.runtime ?? null,
    canvas: () => this.#canvas,
    documentOwner: () => this.#documentOwner,
    explicitPause: () => this.#explicitPause,
  });

  /* ----------------------------------------------------------- load order ---- */
  /**
   * The `src` path holds its `load` event back until framing finished: hosts read
   * `getDimensions()` / the camera in that callback, and both are wrong before
   * `frameViewer()` runs.
   *
   * A counter keeps nested/overlapping load notifications from releasing the
   * event before the last framing pass has finished.
   */
  #pendingSrcLoads = 0;
  #deferredLoadDetail: { sceneId: string; url: string | null } | null = null;
  /**
   * Blob URLs for the last `loadFiles()` call. The current document still points
   * at them, so they are revoked on the *next* load or on disconnect — never
   * right after the load resolves.
   */
  #fileBundle: FileBundle | null = null;
  /** Asset id the current bundle resolves; `null` when no file was loaded. */
  #fileAssetId: string | null = null;
  /** Keeps two files of the same name from colliding in the asset cache. */
  #fileBundleSeq = 0;
  /**
   * Last announced `modelIsVisible`. `model-visibility` is edge-triggered on the
   * composite verdict (loaded × in-viewport × poster dismissed), not on the raw
   * intersection — a poster that hides the model is "not visible" too.
   */
  #modelVisible = false;
  /**
   * Content mounted — `reveal="auto"` then dismisses a late poster at once.
   * Owned here rather than by the slot chrome: it is the load pipeline that
   * mounts content, and `loaded` / `modelIsVisible` both read it.
   */
  #contentLoaded = false;

  /* ------------------------------------------------------ playback state ---- */
  /** Set by `pause()`: an explicit transport stop outranks `autoplay` for later loads. */
  #explicitPause = false;
  /** Clip the transport last started/continued; `null` = nothing played yet. */
  #activeClipName: string | null = null;

  /* --------------------------------------------------------------- canvas ---- */
  /** Canvas this element owns — carries the `alt` text as an `aria-label`. */
  #canvas: HTMLCanvasElement | null = null;

  constructor() {
    super();
    this.#resetReady();
    // Internal no-op catch: unawaited ready must not raise unhandledrejection (D20).
    this.#ready.catch(() => {});
  }

  /** Resolves on init; rejects on failure. Prefer the error event as the必发面 (D6/D20). */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Whether the element currently intersects the viewport (`visibility-change`). */
  get visible(): boolean {
    return this.#intersectionVisible;
  }

  /**
   * model-viewer's `loaded`: true once the `load` event has fired for the
   * current source, and false again as soon as the source changes or the
   * element tears down. It answers "is there content to show", not "is it on
   * screen" — that is {@link modelIsVisible}.
   */
  get loaded(): boolean {
    return this.#contentLoaded;
  }

  /**
   * model-viewer's `modelIsVisible`: content loaded, element in the viewport,
   * and the poster dismissed. The reference also counts `loaded`, so an element
   * that is on screen but still loading reports `false` — this is what a host
   * uses to start/stall a render loop, not a CSS concern.
   */
  get modelIsVisible(): boolean {
    // No IntersectionObserver (SSR, some test DOMs, an explicit opt-out) means
    // "no reason to think it is hidden" — the reference makes the same call.
    const inViewport = this.#intersectionVisible || this.#visibilityObserver === null;
    return this.#contentLoaded && inViewport && this.#slots.revealed;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "mode") {
      this.#applyMode();
      return;
    }
    if (name === "live-view-events") {
      this.#liveViewEvents = value !== null;
      this.#editor?.runtime.setLiveViewEvents?.(this.#liveViewEvents);
      return;
    }
    if (DISPLAY_ATTRIBUTES.has(name)) {
      this.#attrs.applyDisplaySettings();
      return;
    }
    if (name === "environment-image" || name === "skybox-image") {
      // Display-only, same as `tone-mapping`: never written to the document.
      this.#attrs.applyEnvironmentPreset();
      return;
    }
    if (name === "alt") {
      this.#attrs.applyAlt();
      return;
    }
    if (DECODER_ATTRIBUTES.has(name)) {
      // Nothing to rebuild before connect: `#init()` reads the attributes when
      // it builds the runtime. Afterwards a change is a fresh bundle, consumed
      // by the next load (a fetch in flight cannot trade its decoders).
      if (this.#editor) this.#syncDecoders();
      return;
    }
    if (RENDER_ATTRIBUTES.has(name)) {
      // Live, and cheap: the runtime re-evaluates every mounted object instead
      // of rebuilding anything.
      this.#editor?.runtime.setInstancing?.(instancingFrom(value));
      return;
    }
    if (VIEW_ATTRIBUTES.has(name)) {
      // `min/max-field-of-view` only constrain the clamp, so re-run the pose.
      this.#attrs.applyCameraPose(true);
      return;
    }
    if (CAMERA_ATTRIBUTES.has(name)) {
      this.#attrs.applyCameraSettings();
      return;
    }
    if (name === "touch-action") {
      this.#attrs.applyTouchAction();
      return;
    }
    if (SENSITIVITY_ATTRIBUTES.has(name)) {
      this.#attrs.applyCameraSettings();
      return;
    }
    if (PLAYBACK_ATTRIBUTES.has(name)) {
      this.#attrs.applyPlaybackSettings();
      return;
    }
    if (name === "reveal") {
      // `manual` never auto-dismisses; switching back to `auto` after the model
      // is already mounted reveals it immediately.
      if (this.#slots.revealMode === "auto" && this.#contentLoaded) {
        this.#slots.dismissPoster("load");
      } else {
        this.#slots.applyPosterVisibility();
      }
      return;
    }
    if (name === "loading") {
      // Only a *pending* deferred load flushes; a loaded preview must not reload
      // just because the attribute changed.
      if (value !== "lazy" && this.#deferredSrcLoad) this.#maybeLoadSrc();
      return;
    }
    if (name === "src") {
      // `src` is a connect-time declaration, not a reactive input. Re-loading
      // on a later change went through a second GLTF parse that could hang
      // forever with no `load` / `error`, so the dynamic path was removed.
      // It stays in `observedAttributes` only so misuse is diagnosable.
      if (this.#editor && value !== _old && !this.#warnedSrcChange) {
        this.#warnedSrcChange = true;
        console.warn(
          "[scene-editor] `src` is declarative: set it before connecting the element. " +
            "Changing it after initialization has no effect — replace the element " +
            "to show another model, or call loadDocument() for a host-owned document.",
        );
      }
      return;
    }
  }

  connectedCallback(): void {
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }
    if (this.#editor) return;
    if (this.#wasDisconnected) {
      this.#resetReady();
      this.#ready.catch(() => {});
      this.#wasDisconnected = false;
    }
    void this.#init();
  }

  disconnectedCallback(): void {
    this.#wasDisconnected = true;
    this.#abort?.abort();
    this.#abort = null;
    // The next connect builds a new runtime: the mode has to be pushed again.
    this.#appliedMode = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#visibilityObserver?.disconnect();
    this.#visibilityObserver = null;
    this.#intersectionVisible = false;
    this.#visibilityPaused = false;
    this.#tabHidden = false;
    this.#renderPaused = false;
    this.#deferredSrcLoad = false;
    this.#pendingPlugins.length = 0;
    this.#contentLoaded = false;
    this.#slots.reset();
    // Draco/KTX2 each keep a worker alive; the next connect rebuilds the bundle
    // from the attributes anyway.
    this.#decoders?.dispose();
    this.#decoders = null;
    // Uploaded Blob URLs: nothing owns them once the runtime is gone.
    this.#fileBundle?.dispose();
    this.#fileBundle = null;
    this.#fileAssetId = null;
    const editor = this.#editor;
    this.#editor = null;
    try {
      // Facade teardown: plugins → controller disposers → runtime disposers.
      editor?.destroy();
    } catch (err) {
      this.#emitError(SceneErrorCode.Lifecycle, "Controller destroy failed", err);
    }
  }

  /**
   * Install a plugin (design §5: `install(context)` form).
   * Queued if called before init; duplicate id throws.
   */
  use(plugin: SceneEditorPlugin): void {
    const editor = this.#editor;
    if (!editor) {
      if (this.#pendingPlugins.some((p) => p.id === plugin.id)) {
        throw new SceneEditorError(SceneErrorCode.Lifecycle, `Duplicate plugin id: ${plugin.id}`);
      }
      this.#pendingPlugins.push(plugin);
      return;
    }
    editor.use(plugin);
  }

  /** Uninstall a plugin by id; runs its uninstall + disposers. */
  unuse(id: string): void {
    const idx = this.#pendingPlugins.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.#pendingPlugins.splice(idx, 1);
      return;
    }
    this.#editor?.unuse(id);
  }

  async loadDocument(doc: unknown): Promise<void> {
    // Imperative document wins over the declarative `src` attribute.
    this.#documentOwner = "host";
    // Drop a lazy preview that has not fired yet; the host owns the viewport now.
    this.#deferredSrcLoad = false;
    this.#contentLoaded = false;
    // New content, new clip list: the old name would point at nothing.
    this.#activeClipName = null;
    // A host document makes this an editor unless `mode="viewer"` says otherwise.
    this.#applyMode();
    this.#slots.clearError();
    // Editor mode again: back to the warm room unless the host chose otherwise.
    this.#attrs.applyEnvironmentPreset();
    this.#slots.setLoading(true);
    performance.mark("scene-editor:load:start");
    try {
      // A host document may reference compressed assets too (the studio's own
      // import path does), so the same bundle is resolved here.
      await this.#prepareDecoders();
      await this.#requireEditor().loadDocument(doc);
      // Same reason as the `src` path: the document's `view` lands after the
      // `load` event, so display-only attributes are re-asserted afterwards.
      this.#attrs.reassertDisplaySettings();
    } finally {
      this.#slots.setLoading(false);
      performance.mark("scene-editor:load:end");
      try {
        performance.measure("scene-editor:load", "scene-editor:load:start", "scene-editor:load:end");
      } catch {
        // older engines without measure window — marks alone are enough
      }
    }
  }

  /**
   * Load a dropped/picked file set (`.glb`, `.gltf` + its `.bin`/textures,
   * `.obj`, `.stl`).
   *
   * Everything a host would otherwise hand-roll lives here: pick the primary
   * file, inline a `.gltf` bundle's relative URIs as Blob URLs
   * (`createFileBundleUrl`), synthesize the one-mesh document, then run the same
   * path `src` uses — decoders, framing, held `load` event, error overlay.
   *
   * The previous bundle is revoked on the next call (and on disconnect); the
   * document keeps pointing at it in between, so it cannot be revoked earlier.
   */
  async loadFiles(files: readonly File[] | FileList): Promise<void> {
    const bundle = await createFileBundleUrl(files, {
      assetIdPrefix: `upload-${++this.#fileBundleSeq}`,
    });
    const previous = this.#fileBundle;
    this.#fileBundle = bundle;
    this.#fileAssetId = bundle.assetId;
    previous?.dispose();

    await this.#loadPreview(
      createDocumentFromAsset({
        assetId: bundle.assetId,
        name: bundle.name,
        baseView: createPreviewViewState(),
      }),
    );
  }

  /**
   * Export the **document** (not what is on screen) as a Blob — `glb` (default),
   * `gltf` or `obj`.
   *
   * The difference from {@link exportScene} is what gets serialized: that one
   * walks the live roots (preview offsets, display-mode materials and a gizmo
   * mid-drag all included), this one re-applies the stored transforms first.
   * Clips stay with the asset: the document does not own them.
   */
  async exportDocument(options: SceneExportOptions = {}): Promise<Blob> {
    const runtime = this.#requireEditor().runtime;
    if (!runtime.exportDocument) {
      throw new SceneEditorError(
        SceneErrorCode.Lifecycle,
        "Runtime does not support document export (exportDocument)",
      );
    }
    return runtime.exportDocument(this.getDocument(), { format: options.format ?? "glb" });
  }

  /** Live runtime (e.g. ThreeRuntime) for host-side GPU / scene access. */
  get runtime(): RuntimeContract {
    return this.#requireEditor().runtime;
  }

  getDocument(): SceneDocument {
    return this.#requireEditor().getDocument();
  }

  get revision(): number {
    return this.#requireEditor().revision;
  }

  get dirty(): boolean {
    return this.#requireEditor().dirty;
  }

  get selectedIds(): readonly string[] {
    return this.#requireEditor().selectedIds;
  }

  /**
   * Resolves when the runtime finished mounting viewport controls (gizmo).
   * FakeRuntime and other non-three runtimes resolve immediately.
   */
  get controlsReady(): Promise<void> {
    const runtime = this.#requireEditor().runtime as {
      controlsReady?: Promise<void>;
    };
    return runtime.controlsReady ?? Promise.resolve();
  }

  /** Host confirmed save: adopt server revision and clear dirty (D17/D18). */
  markSaved(serverRevision: number): void {
    this.#requireEditor().markSaved(serverRevision);
  }

  /**
   * Inbound remote update (D17): fast-forwards only when there are no local
   * edits and the remote is the exact next revision; otherwise rejects with a
   * structured `conflict` error carrying `{ base, incoming, local }`.
   */
  applyRemote(input: unknown, options: { baseRevision: number }): Promise<void> {
    return this.#requireEditor().applyRemote(input, options);
  }

  selectObject(id: string): void {
    this.#requireEditor().select([id]);
  }

  /** Set the selection to exactly `ids` (multi-select, same semantics as the facade). */
  select(ids: string[]): void {
    this.#requireEditor().select(ids);
  }

  /** Add ids to the current selection (shift/ctrl click, marquee results). */
  addToSelection(ids: string[]): void {
    this.#requireEditor().add(ids);
  }

  /** Remove ids from the current selection. */
  removeFromSelection(ids: string[]): void {
    this.#requireEditor().remove(ids);
  }

  /** Flip one id in the current selection. */
  toggleSelection(id: string): void {
    this.#requireEditor().toggle(id);
  }

  executeCommand(command: Command): void {
    this.#requireEditor().executeCommand(command);
  }

  applyTransform(id: string, from: Transform, to: Transform): void {
    this.#requireEditor().applyTransform(id, from, to);
  }

  addObject(dto: SceneObjectDTO): Promise<void> {
    return this.#requireEditor().addObject(dto);
  }

  removeObject(id: string): void {
    this.#requireEditor().removeObject(id);
  }

  reparent(id: string, parentId: string | undefined): void {
    this.#requireEditor().reparent(id, parentId);
  }

  setMaterial(id: string, material: MaterialDTO | undefined): void {
    this.#requireEditor().setMaterial(id, material);
  }

  undo(): void {
    this.#requireEditor().undo();
  }

  redo(): void {
    this.#requireEditor().redo();
  }

  clearSelection(): void {
    this.#requireEditor().clearSelection();
  }

  /** Authoritative save path (D18): hosts persist in response to this event. */
  requestSave(): void {
    this.#requireEditor().requestSave();
  }

  /** Live viewport view from the runtime (camera, lights, environment). */
  getViewState(): ViewState {
    return this.#requireEditor().getViewState();
  }

  /** Explicitly record + apply a view. Marks dirty, never undoable (D22). */
  setViewState(view: ViewState): void {
    this.#requireEditor().setViewState(view);
  }

  /**
   * Fit the camera to the current content ("reset view"). Does not touch the
   * document, so it never marks the scene dirty.
   */
  frameModel(): void {
    this.#requireEditor().runtime.autoFrame?.();
  }

  /** World-space size of the mounted content (`0` per axis when empty). */
  getDimensions(): { width: number; height: number; depth: number } {
    return this.#requireEditor().runtime.dimensions?.() ?? { width: 0, height: 0, depth: 0 };
  }

  /** World-space hit point + surface normal under a client coordinate. */
  positionAndNormalFromPoint(
    clientX: number,
    clientY: number,
  ): { position: [number, number, number]; normal: [number, number, number] } | null {
    return (
      this.#requireEditor().runtime.positionAndNormalFromPoint?.(clientX, clientY) ?? null
    );
  }

  /**
   * Live state of a `slot="hotspot-<name>"` anchor — model-viewer's
   * `queryHotspot()`, for hosts that draw leader lines or collision-sort labels
   * in screen space.
   *
   * `null` when no anchor carries that slot name, before the runtime exists, or
   * when the projection is non-finite (the anchor sits far outside the frustum).
   * Unlike the projection used for placement, a hotspot that is merely
   * behind the camera still reports — check `facingCamera` / `canvasPosition`
   * rather than assuming non-null means on-screen.
   */
  queryHotspot(name: string): HotspotData | null {
    return this.#slots.queryHotspot(name);
  }

  /**
   * Move a hotspot without touching the DOM — model-viewer's
   * `updateHotspot({name, position?, normal?, surface?})`.
   *
   * `position` / `normal` are strings in the same format as `data-position` /
   * `data-normal` (`"1 2 3"`, unit suffixes allowed). Omitted fields are left
   * alone; an unparseable field is ignored rather than throwing, so a host
   * feeding user input cannot break the anchor. Unknown names are a silent
   * no-op, exactly like the reference.
   *
   * Every anchor sharing the slot name moves: the reference keeps one hotspot
   * per slot name, so all of its nodes travel together.
   *
   * `surface` is accepted for signature compatibility but has no effect —
   * surface tracking (`data-surface` / `surfaceFromPoint()`) is not
   * implemented. Unlike the reference, this element *does* observe
   * `data-position` / `data-normal`, so the attribute route works too.
   */
  updateHotspot(config: HotspotConfig): void {
    this.#slots.updateHotspot(config);
  }

  /** Render, then capture the canvas (`image/png` by default). */
  async toDataURL(type = "image/png", quality?: number): Promise<string> {
    const runtime = this.#requireEditor().runtime;
    if (!runtime.toDataURL) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Runtime does not support capture");
    }
    return runtime.toDataURL(type, quality);
  }

  /** Render, then capture the canvas as a Blob. */
  async toBlob(type = "image/png", quality?: number): Promise<Blob | null> {
    const runtime = this.#requireEditor().runtime;
    if (!runtime.toBlob) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Runtime does not support capture");
    }
    return runtime.toBlob(type, quality);
  }

  /** Export the document objects as GLB (default) or `.gltf` JSON. */
  async exportScene(options: { binary?: boolean } = {}): Promise<ArrayBuffer | string> {
    const runtime = this.#requireEditor().runtime;
    if (!runtime.exportScene) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Runtime does not support export");
    }
    return runtime.exportScene(options);
  }

  /** Hide the `slot="poster"` overlay now (model-viewer's `dismissPoster()`). */
  dismissPoster(): void {
    this.#slots.dismissPoster("api");
  }

  /** Re-scan `slot="…"` children (call after adding/removing them dynamically). */
  refreshSlots(): void {
    this.#slots.collect();
  }

  #requireEditor(): SceneEditor {
    if (!this.#editor) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor not initialized");
    }
    return this.#editor;
  }

  /**
   * The host's resolver, with the element's own reserved ids in front.
   *
   * `src` and `loadFiles()` mint asset ids the host cannot know (a Blob URL has
   * no stable name), so they must win over the host table. Everything else is
   * the host's call — including rejecting it.
   */
  #createAssetResolver(): AssetResolver {
    const host = this.assetResolver;
    if (!host) return this.#createSrcResolver();
    const reserved = this.#createSrcResolver();
    return {
      resolve: async (assetId) => {
        if (assetId === SRC_ASSET_ID || assetId === this.#fileAssetId) {
          return reserved.resolve(assetId);
        }
        return host.resolve(assetId);
      },
    };
  }

  #createSrcResolver(): AssetResolver {
    return {
      resolve: async (assetId) => {
        if (assetId === this.#fileAssetId && this.#fileBundle) {
          return this.#fileBundle.url;
        }
        if (assetId !== SRC_ASSET_ID) {
          throw new Error(`Unknown asset: ${assetId}`);
        }
        const src = this.src;
        if (!src) throw new Error("src is no longer set");
        return src;
      },
    };
  }

  /**
   * Push the effective mode to the runtime and mirror it for CSS. Called on
   * connect, on `mode` changes, and when a host document takes over from the
   * declarative preview — the mode is derived, so it has to be re-derived.
   */
  #applyMode(): void {
    const mode = this.mode;
    if (this.getAttribute("data-mode") !== mode) this.setAttribute("data-mode", mode);
    const editor = this.#editor;
    if (!editor) return;
    // De-duplicated: both connect and every load re-derive the mode, and the
    // runtime tears the gizmo down on each switch.
    if (this.#appliedMode === mode) return;
    this.#appliedMode = mode;
    editor.runtime.setInteractive?.(mode === "editor");
    // A viewer has no selection. Clearing here also removes whatever outline a
    // previous editor pass left on the object.
    if (mode === "viewer") editor.clearSelection();
  }

  /**
   * Where the decoder payloads live, or `null` when the host opted out.
   *
   * `decoder-path` wins over `decoder-cdn` so a self-hosting page can keep the
   * boolean attribute in its template and override the URL per environment
   * (local CDN / air-gapped mirror) without touching the rest.
   */
  #decoderPath(): string | null {
    const explicit = (this.getAttribute("decoder-path") ?? "").trim();
    if (explicit) return explicit;
    return this.hasAttribute("decoder-cdn") ? DEFAULT_DECODER_CDN : null;
  }

  /** Rebuild the bundle from the current attributes; cheap when disabled. */
  #syncDecoders(): void {
    this.#decoders?.dispose();
    this.#decoders = null;
    const path = this.#decoderPath();
    if (!path) return;
    this.#decoders = SceneEditorElement.decoderBundleFactory({
      path,
      // KTX2's `detectSupport()` has to probe the real device. Runtimes that do
      // not expose a renderer simply skip KTX2 and keep Draco + Meshopt.
      getRenderer: () => this.#editor?.runtime.renderer,
    });
  }

  /**
   * Resolve the decoder bundle before a load starts. `createResolverAssetLoader`
   * reads decoders synchronously per load, so the async half has to happen here.
   * Failures are already absorbed per decoder — nothing to handle.
   */
  async #prepareDecoders(): Promise<void> {
    const bundle = this.#decoders;
    if (!bundle) return;
    try {
      await bundle.ready();
    } catch {
      // `ready()` degrades internally; this is only belt and braces.
    }
  }

  async #loadSrc(): Promise<void> {
    const src = this.src;
    if (!this.#editor || !src) return;
    await this.#loadPreview(createSrcDocument(src));
  }

  /**
   * Shared body of the two "one model, host does not own the document" paths:
   * `src` and `loadFiles()`. Holds `load` until framing finished, re-asserts the
   * display-only attributes, and owns the failure surface.
   */
  async #loadPreview(doc: SceneDocument): Promise<void> {
    const editor = this.#editor;
    if (!editor) return;
    this.#deferredSrcLoad = false;
    this.#documentOwner = "src";
    this.#contentLoaded = false;
    // New content, new clip list: the old name would point at nothing.
    this.#activeClipName = null;
    // A preview load can flip the derived mode to viewer (see `mode`).
    this.#applyMode();
    // A new source is a fresh attempt: drop the previous failure surface.
    this.#slots.clearError();
    this.#srcLoadFailed = false;
    // Hold `load` until `frameViewer()` ran (see `#pendingSrcLoads`).
    this.#pendingSrcLoads += 1;
    this.#deferredLoadDetail = null;
    // Preview mode may have just switched the default preset to `neutral`.
    this.#attrs.applyEnvironmentPreset();
    this.#slots.setLoading(true);
    try {
      // Decoders first: a Draco/KTX2/Meshopt asset cannot even parse without
      // them, and the loader reads them synchronously once the load starts.
      await this.#prepareDecoders();
      await editor.loadDocument(doc);
      // Viewer framing (model-viewer parity); a plain fit is the fallback.
      // Nothing mounted means nothing to frame — framing an empty scene would
      // park the camera at the origin for the next successful load.
      const runtime = editor.runtime;
      if (!this.#srcLoadFailed) {
        if (runtime.frameViewer) runtime.frameViewer();
        else runtime.autoFrame?.();
      }
      // A loaded document applies its own `view` *after* the `load` event, so
      // display-only attributes (tone mapping / exposure / contact shadow) are
      // re-asserted here, once the host's document is the current one. Framing
      // comes first: the shadow pass re-applies the camera it reads.
      this.#attrs.reassertDisplaySettings();
    } catch {
      // The facade already emitted `error`; swallowing keeps the
      // fire-and-forget call site free of unhandled rejections.
    } finally {
      // Release the held `load` once the last overlapping load is framed.
      this.#pendingSrcLoads = Math.max(0, this.#pendingSrcLoads - 1);
      if (this.#pendingSrcLoads === 0) this.#flushDeferredLoad();
      this.#slots.setLoading(false);
    }
  }

  /** Dispatch the `load` held back by the `src` path, then dismiss the poster. */
  #flushDeferredLoad(): void {
    const detail = this.#deferredLoadDetail;
    this.#deferredLoadDetail = null;
    if (!detail) return;
    this.dispatchEvent(new CustomEvent("load", { detail }));
    // `reveal="auto"` (the default): the framed model is on screen — drop the poster.
    this.#slots.dismissPoster("load");
  }


  /**
   * Land on the last camera goal immediately instead of fading into it
   * (model-viewer `jumpCameraToGoal()`). Returns `false` when nothing is easing.
   */
  jumpCameraToGoal(): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime?.jumpCameraToGoal) return false;
    runtime.jumpCameraToGoal();
    return true;
  }


  /* ----------------------------------------------------------- camera api ---- */

  /** Current orbit angles (`theta` / `phi` in degrees, `radius` in world units). */
  getCameraOrbit(): CameraOrbit | null {
    const view = this.#editor?.runtime.getViewState();
    if (!view) return null;
    return orbitFromCamera(view.camera.position, view.camera.target);
  }

  /**
   * Set the orbit. Missing axes keep their current value, mirroring
   * `camera-orbit="auto"`. Returns `false` only when nothing is mounted; an empty
   * scene falls back to model-viewer's default front view rather than failing.
   */
  setCameraOrbit(orbit: Partial<CameraOrbit>): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime) return false;
    const view = runtime.getViewState();
    const current = orbitFromCamera(view.camera.position, view.camera.target);
    const base = current ?? { theta: 0, phi: 75, radius: 1 };
    const position = cameraFromOrbit(view.camera.target, {
      theta: orbit.theta ?? base.theta,
      phi: orbit.phi ?? base.phi,
      radius: orbit.radius ?? base.radius,
    });
    this.#attrs.commitCamera(view, { ...view.camera, position }, false);
    return true;
  }

  /** Orbit target (the point the camera circles). */
  getCameraTarget(): [number, number, number] {
    const target = this.#editor?.runtime.getViewState().camera.target;
    return target ? [target[0], target[1], target[2]] : [0, 0, 0];
  }

  setCameraTarget(target: readonly [number, number, number]): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime) return false;
    const view = runtime.getViewState();
    const orbit = orbitFromCamera(view.camera.position, view.camera.target);
    const nextTarget: [number, number, number] = [target[0], target[1], target[2]];
    const position = orbit ? cameraFromOrbit(nextTarget, orbit) : nextTarget;
    this.#attrs.commitCamera(view, { ...view.camera, position, target: nextTarget }, false);
    return true;
  }

  /** Vertical FOV in degrees, as rendered. */
  getFieldOfView(): number {
    return this.#editor?.runtime.getViewState().camera.fov ?? 0;
  }

  setFieldOfView(degrees: number): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime || !Number.isFinite(degrees) || degrees <= 0) return false;
    const view = runtime.getViewState();
    const fov = this.#attrs.clampFieldOfView(degrees);
    this.#attrs.commitCamera(view, { ...view.camera, fov }, false);
    return true;
  }

  /* ----------------------------------------------------------- transport ---- */

  /**
   * Clip names on the mounted content — model-viewer's `availableAnimations`.
   * De-duplicated: two objects may ship a clip called `Take 001`, and a host
   * building a `<select>` wants one entry per name.
   */
  get availableAnimations(): string[] {
    const clips = this.#editor?.runtime.animations;
    if (!clips || clips.length === 0) return [];
    return [...new Set(clips.map((clip) => clip.name))];
  }

  /** Active clip name; falls back to the `animation-name` attribute. */
  get animationName(): string | null {
    if (this.#activeClipName !== null) return this.#activeClipName;
    const raw = this.getAttribute("animation-name");
    return raw === null || raw.trim() === "" ? null : raw.trim();
  }
  /**
   * Select and start a clip (model-viewer semantics: assigning the name plays
   * it). Honours an explicit `pause()`: a paused transport stays paused and only
   * changes which clip it will resume.
   */
  set animationName(value: string | null) {
    if (value === null || value.trim() === "") this.removeAttribute("animation-name");
    else this.setAttribute("animation-name", value);
    if (this.#explicitPause) return;
    this.play();
  }

  /** `true` while nothing advances the mixers — before load and after `pause()`. */
  get paused(): boolean {
    return !(this.#editor?.runtime.animationPlaying ?? false);
  }

  /**
   * Start (or resume) playback. A paused transport continues from its playhead;
   * otherwise the `animation-name` clip starts from the top, falling back to the
   * first clip of the first animated object. Returns `false` when there is
   * nothing to play.
   */
  play(): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime?.playAnimation) return false;
    this.#explicitPause = false;
    if (runtime.resumeAnimations?.()) {
      this.#noteActiveClip(this.animationName);
      return true;
    }
    const name = this.getAttribute("animation-name")?.trim() || null;
    const started = name === null ? runtime.playAnimation() : this.#startClipNamed(name);
    if (started) this.#noteActiveClip(name ?? runtime.animations?.[0]?.name ?? null);
    return started;
  }

  /** Hold the playhead. Outranks `autoplay` for every later load. */
  pause(): void {
    this.#explicitPause = true;
    this.#editor?.runtime.pauseAnimations?.();
  }

  /** Playhead of the active clip, in seconds. */
  get currentTime(): number {
    return this.#editor?.runtime.animationTime ?? 0;
  }
  set currentTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.#editor?.runtime.setAnimationTime?.(seconds);
  }

  /** Playback rate multiplier (`1` = authored speed, `0` freezes the mixer). */
  get timeScale(): number {
    return this.#editor?.runtime.animationSpeed ?? 1;
  }
  set timeScale(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.#editor?.runtime.setAnimationSpeed?.(value);
  }

  /**
   * Start a clip by name. Runtimes that expose `playAnimationByName` own the
   * lookup; the rest are resolved against the clip list the same way
   * `animation-rig` does (case-insensitive, first hit wins).
   */
  #startClipNamed(name: string): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime) return false;
    const byName = runtime.playAnimationByName?.(name);
    if (byName !== undefined) return byName;
    const wanted = name.toLowerCase();
    const clip = runtime.animations?.find((candidate) => candidate.name.toLowerCase() === wanted);
    return clip ? (runtime.playAnimation?.(clip.objectId, clip.index) ?? false) : false;
  }

  #noteActiveClip(name: string | null): void {
    if (name !== null) this.#activeClipName = name;
  }


  /** Variant names declared by the loaded asset(s) — model-viewer `availableVariants`. */
  get availableVariants(): string[] {
    return this.#editor?.runtime.variants ?? [];
  }

  /** Current `KHR_materials_variants` pick; `null` = the asset's own materials. */
  get variantName(): string | null {
    const raw = this.getAttribute("variant-name");
    return raw === null || raw.trim() === "" ? null : raw.trim();
  }
  set variantName(value: string | null) {
    if (value === null || value === "") this.removeAttribute("variant-name");
    else this.setAttribute("variant-name", value);
  }

  /* ------------------------------------------------- embedded cameras ---- */

  /** Cameras authored inside the loaded asset (glTF `node.camera`). */
  get cameras(): string[] {
    return this.#editor?.runtime.cameras ?? [];
  }

  /** Active embedded camera; `null` = the document/orbit view. */
  get cameraName(): string | null {
    const raw = this.getAttribute("camera-name");
    return raw === null || raw.trim() === "" ? null : raw.trim();
  }
  set cameraName(value: string | null) {
    if (value === null || value === "") this.removeAttribute("camera-name");
    else this.setAttribute("camera-name", value);
  }

  /**
   * Look through an authored camera (`null` restores the orbit view). Returns
   * `false` when the name is not loaded yet — it stays remembered and applies on
   * the next load, which is also what the `camera-name` attribute does.
   */
  setCameraByName(name: string | null): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime?.setCameraByName) return false;
    if (name === null) {
      this.removeAttribute("camera-name");
      return runtime.setCameraByName(null);
    }
    this.setAttribute("camera-name", name);
    return runtime.setCameraByName(name);
  }

  /**
   * Roll the turntable back to `theta` radians (default 0), model-viewer
   * `resetTurntableRotation(theta)`: after the call the turntable reads `theta`,
   * while the orbit the user dragged to is left exactly where it is. Returns
   * `false` when the runtime cannot do it (no turntable support).
   */
  resetTurntableRotation(theta?: number): boolean {
    const runtime = this.#editor?.runtime;
    if (!runtime?.resetTurntableRotation) return false;
    runtime.resetTurntableRotation(theta);
    return true;
  }

  /* ------------------------------------------------------ morph targets ---- */

  /** Every morph channel on the mounted content, with weights and animation state. */
  get morphTargets(): MorphTargetInfo[] {
    return this.#editor?.runtime.morphTargets ?? [];
  }

  /**
   * Set one morph weight. Returns `false` when the channel is gone or a playing
   * clip drives it — pause the animation first, or the mixer wins the next frame.
   */
  setMorphInfluence(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean {
    return (
      this.#editor?.runtime.setMorphInfluence?.(objectId, meshIndex, targetIndex, value) ??
      false
    );
  }


  /**
   * Load the declarative `src` once — unless `loading="lazy"` and the element is
   * still off-screen. Without an IntersectionObserver there is no "visible"
   * moment to wait for, so the load stays eager.
   */
  #maybeLoadSrc(): void {
    if (!this.src) return;
    // A host-owned document outranks the declarative attribute.
    if (this.#documentOwner === "host") return;
    const canDefer =
      this.getAttribute("loading") === "lazy" &&
      this.#visibilityObserver !== null &&
      !this.#intersectionVisible;
    if (canDefer) {
      this.#deferredSrcLoad = true;
      return;
    }
    this.#deferredSrcLoad = false;
    void this.#loadSrc();
  }

  #resetReady(): void {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  /**
   * Connect-time assembly, one stage per call. The order below is load-bearing —
   * `alt` before the runtime, decoders before the first load, framing before the
   * held `load` — so stages may be renamed but not reordered.
   */
  async #init(): Promise<void> {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    try {
      const canvas = this.#mountCanvas();
      const { runtime, editor } = this.#createRuntime(canvas);
      this.#pushInitialState(runtime);
      this.#wireInput(editor, runtime, canvas, signal);
      this.#wireViewport(runtime, signal);
      this.#forwardFacadeEvents(editor);
      this.#publishReady(editor);
    } catch (err) {
      const se =
        err instanceof SceneEditorError
          ? err
          : new SceneEditorError(SceneErrorCode.Lifecycle, "Editor init failed", {
              cause: err,
            });
      this.#emitError(se.code, se.message, se.cause);
      this.#rejectReady(se);
    }
  }

  /**
   * The canvas, plus the two DOM-only attributes (`alt`, `touch-action`).
   *
   * Both land before the runtime exists on purpose: an attribute set before
   * upgrade must still take effect, and neither has anything for the runtime to
   * re-assert later.
   */
  #mountCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    this.appendChild(canvas);
    // The canvas is the accessible representation of the model (`alt`).
    this.#canvas = canvas;
    this.#attrs.applyAlt();
    // DOM-only, so it lands before the runtime exists. Also the reason an
    // attribute set before upgrade still takes effect: nothing to re-assert.
    this.#attrs.applyTouchAction();
    return canvas;
  }

  /**
   * Build the runtime, wrap it in the headless facade, publish it as `#editor`.
   *
   * The factory options are the connect-time snapshot of the derived inputs
   * (host document vs `src` preview, mode, `instancing`); `#pushInitialState`
   * repeats them for the benefit of a custom factory that dropped one.
   *
   * `#syncDecoders` runs *after* the editor so the KTX2 renderer accessor has
   * something to read; the bundle itself imports nothing until the first load
   * asks for it.
   */
  #createRuntime(canvas: HTMLCanvasElement): {
    runtime: RuntimeContract;
    editor: SceneEditor;
  } {
    const assetResolver = this.#createAssetResolver();
    const environmentPreset = this.#attrs.environmentPreset();
    const interactive = this.mode === "editor";
    const instancing = this.instancing;
    const runtime = SceneEditorElement.runtimeFactory(canvas, {
      assetResolver,
      environmentPreset,
      interactive,
      instancing,
      getDecoders: () => {
        // Host-assigned instances win over the bundle: a host that built its
        // own KTX2Loader (or pointed Draco somewhere specific) meant it.
        const lazy = this.#decoders?.current() ?? {};
        return {
          // `?? null`, not `?? undefined`: "not set" has always been reported
          // as `null` here, and a host clearing `el.ktx2Loader = null` must
          // see that back.
          dracoLoader: this.#dracoLoader ?? lazy.dracoLoader ?? null,
          ktx2Loader: this.#ktx2Loader ?? lazy.ktx2Loader ?? null,
          meshoptDecoder: this.#meshoptDecoder ?? lazy.meshoptDecoder ?? null,
        };
      },
      // Read at load time, so setting it before the fetch is enough — the
      // model and its external buffers both pick it up.
      getWithCredentials: () => this.hasAttribute("with-credentials"),
    });
    const editor = createSceneEditor({ runtime });
    this.#editor = editor;
    // After the editor so the KTX2 renderer accessor has something to read;
    // the bundle itself imports nothing until the first load asks for it.
    this.#syncDecoders();
    return { runtime, editor };
  }

  /**
   * Replay the attributes that were already present when the element upgraded.
   * `observedAttributes` fires *during* upgrade, when there is no runtime to
   * push to, so everything declared in markup lands here instead.
   *
   * Order is the original one: display → camera → playback → environment (the
   * URL override and the skybox only exist as attributes) → `touch-action` (the
   * orbit addon overwrites it on mount) → mode (needs the runtime).
   */
  #pushInitialState(runtime: RuntimeContract): void {
    // Attributes set before upgrade land here: observedAttributes fires during
    // upgrade, but the runtime only exists now.
    runtime.setLiveViewEvents?.(this.#liveViewEvents);
    // The default factory already got this; repeating it covers a custom
    // factory that dropped the option (and is a no-op when it did not).
    runtime.setInstancing?.(this.instancing);
    // Everything the attributes declare, in the connect-time order; the
    // environment preset is re-pushed inside (factory option or not).
    this.#attrs.applyInitial();
    // Now that a runtime exists, the mode can be pushed to it (the factory
    // already received `interactive`; this applies the derived viewer/editor
    // mode from the connect-time `src` declaration).
    this.#applyMode();
  }

  /**
   * Turn user input into editor actions: click-to-select, the first-gesture
   * poster reveal, the gizmo's commit command, and the keyboard domain.
   */
  #wireInput(
    editor: SceneEditor,
    runtime: RuntimeContract,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): void {
    // Click-to-select (P2-T7): pick on canvas click, empty → clear.
    // Shift / Ctrl / Cmd makes the click additive (toggle), matching the
    // facade's multi-select surface (`add` / `remove` / `toggle`).
    const onClick = (event: MouseEvent): void => {
      // A viewer has no selection at all — orbit is its only pointer verb.
      if (this.mode === "viewer") return;
      // `disable-tap` keeps orbit/zoom but never turns a click into a selection.
      if (this.hasAttribute("disable-tap")) return;
      const picked = runtime.pick(event.clientX, event.clientY);
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!picked) {
        if (!additive) editor.clearSelection();
        return;
      }
      if (additive) editor.toggle(picked);
      else editor.select([picked]);
    };
    canvas.addEventListener("click", onClick, { signal });

    // `reveal="interaction"`: the first gesture (orbit, zoom, key) dismisses
    // the poster. Passive — the viewer must never block gestures.
    const onFirstInteraction = (): void => {
      this.#slots.dismissPoster("interaction");
    };
    for (const type of ["pointerdown", "wheel", "touchstart"]) {
      this.addEventListener(type, onFirstInteraction, { signal, passive: true });
    }

    // One TransformControls drag → one undoable command (D15 / P2-T6).
    runtime.events.on("transform-commit", ({ id, from, to }) => {
      editor.applyTransform(id, from, to);
    });

    // Keys are input too: the focus domain, the editor commands and the camera
    // fallbacks all live in `#onKeyDown`.
    this.addEventListener("keydown", this.#onKeyDown, { signal });
  }

  /**
   * Keep the viewport in sync with the element's box and its visibility: resize
   * → `runtime.resize()` plus hotspot reprojection, `IntersectionObserver` →
   * off-screen pause, background tab → the same pause.
   */
  #wireViewport(runtime: RuntimeContract, signal: AbortSignal): void {
    // resize seam: ThreeRuntime exposes resize(); FakeRuntime does not (optional).
    const maybeResize = runtime as { resize?: (w?: number, h?: number) => void };
    const applySize = (): void => {
      maybeResize?.resize?.(this.clientWidth, this.clientHeight);
      // Hotspot anchors are canvas-local pixels: re-project after a resize.
      this.#slots.updateHotspots();
    };
    applySize();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(applySize);
      ro.observe(this);
      this.#resizeObserver = ro;
    }

    // Element-only visibility signal (IntersectionObserver; opt-out by
    // setting `visibilityObserverFactory = () => null`).
    this.#visibilityObserver = SceneEditorElement.visibilityObserverFactory(
      this.#onVisibilityChange,
    );
    this.#visibilityObserver?.observe(this);

    // Background tabs pause too; rAF is throttled there but a hidden viewer
    // still wakes up for animation ticks and paints.
    if (typeof document !== "undefined") {
      const onDocumentHidden = (): void => {
        this.#tabHidden = document.hidden === true;
        this.#setRenderingPaused();
      };
      document.addEventListener("visibilitychange", onDocumentHidden, { signal });
      this.#tabHidden = document.hidden === true;
    }
  }

  /**
   * Facade events → DOM `CustomEvent`s (element public contract, D18/D20).
   *
   * One flat table on purpose: every row is the same two-line forward, in the
   * order the facade declares them. The two rows that carry real work
   * (`camera-change` reprojects hotspots, `load` releases the held event) say so
   * inline.
   */
  #forwardFacadeEvents(editor: SceneEditor): void {
    editor.on("selection-change", (payload) => {
      this.dispatchEvent(new CustomEvent("selection-change", { detail: payload }));
    });
    editor.on("history-change", (payload) => {
      this.dispatchEvent(new CustomEvent("history-change", { detail: payload }));
    });
    editor.on("document-dirty", (payload) => {
      this.dispatchEvent(new CustomEvent("document-dirty", { detail: payload }));
    });
    editor.on("save-request", (payload) => {
      this.dispatchEvent(new CustomEvent("save-request", { detail: payload }));
    });
    editor.on("view-change", (payload) => {
      this.dispatchEvent(new CustomEvent("view-change", { detail: payload }));
    });
    editor.on("view-changing", (payload) => {
      this.dispatchEvent(new CustomEvent("view-changing", { detail: payload }));
    });
    editor.on("camera-change", (camera) => {
      this.dispatchEvent(new CustomEvent("camera-change", { detail: camera }));
      // Hotspots are screen-space projections of world points.
      this.#slots.updateHotspots();
    });
    editor.on("environment-change", (payload) => {
      this.dispatchEvent(new CustomEvent("environment-change", { detail: payload }));
    });
    editor.on("progress", (payload) => {
      // Any progress sample means a load is in flight → show the progress bar.
      this.#slots.setLoading(true);
      this.dispatchEvent(new CustomEvent("progress", { detail: payload }));
    });
    // Playback transport (model-viewer parity). `play` keeps a payload that
    // says *what* started; `pause` / `finished` carry none upstream either.
    editor.on("play", (payload) => {
      this.#noteActiveClip(payload.name);
      this.dispatchEvent(new CustomEvent("play", { detail: payload }));
    });
    editor.on("pause", () => {
      this.dispatchEvent(new CustomEvent("pause", { detail: {} }));
    });
    editor.on("loop", (payload) => {
      this.dispatchEvent(new CustomEvent("loop", { detail: payload }));
    });
    editor.on("finished", () => {
      this.dispatchEvent(new CustomEvent("finished", { detail: {} }));
    });
    editor.on("load", (payload) => {
      // A preview is *one* asset, so the store's "partial success" rule (skip
      // the broken object, keep the rest) leaves nothing to show. Announcing
      // `load` here would be a lie host code acts on — and the `#clearError()`
      // below would erase the only explanation on screen.
      if (this.#documentOwner === "src" && this.#srcLoadFailed) {
        this.#slots.setLoading(false);
        this.#syncModelVisibility();
        this.#slots.updateHotspots();
        return;
      }
      // Only the `src` path knows a URL; headless/host documents report null.
      const url = this.#documentOwner === "src" ? this.src : null;
      this.#contentLoaded = true;
      this.#slots.setLoading(false);
      this.#slots.clearError();
      const detail = { ...payload, url };
      if (this.#pendingSrcLoads > 0) {
        // Hold the event back: `frameViewer()` has not run yet, so a host
        // reading `getDimensions()` or the camera here would see pre-fit state.
        // Only the load that drains the counter to zero releases the event.
        this.#deferredLoadDetail = detail;
        this.#syncModelVisibility();
        this.#slots.updateHotspots();
        return;
      }
      this.dispatchEvent(new CustomEvent("load", { detail }));
      this.#syncModelVisibility();
      this.#slots.updateHotspots();
      // `reveal="auto"` (the default): the model is on screen — drop the poster.
      this.#slots.dismissPoster("load");
    });
    editor.on("error", (payload) => {
      this.#slots.setLoading(false);
      // A conflict is a decision point, not a failure: the host resolves it with
      // its own UI, and a full-canvas message would cover the very model the
      // user is comparing. Every other code still gets the visual state.
      if (payload.code !== SceneErrorCode.Conflict) {
        // The event alone left hosts with a blank canvas; the message is now
        // also a visual state (`slot="error"`, or the built-in overlay).
        this.#slots.showError(payload.message);
      }
      // A preview owns exactly one asset: remember that this load produced
      // nothing, so the `load` that follows cannot announce success.
      if (this.#documentOwner === "src") this.#srcLoadFailed = true;
      this.dispatchEvent(new CustomEvent("error", { detail: payload }));
    });
  }

  /**
   * The tail of a connect: adopt the light-DOM slots, announce `scene-ready`,
   * resolve `ready`, kick the deferred `src` load, then install the plugins a
   * host queued with `use()` before the element connected.
   *
   * A failing install surfaces as an `error` event instead of rejecting
   * `ready` — the element itself is up and the host can `unuse()` the plugin.
   */
  #publishReady(editor: SceneEditor): void {
    // Slots live in the light DOM (no shadow root): adopt whatever is already
    // there, then keep watching for later additions.
    this.#slots.observe();
    this.#slots.collect();

    this.dispatchEvent(new CustomEvent("scene-ready"));
    this.#resolveReady();

    // Declarative preview loads after `ready`, so a host that awaits the
    // element still observes `progress` / `load`. `loading="lazy"` defers it
    // until the element is first visible.
    if (this.src && this.#documentOwner !== "host") this.#maybeLoadSrc();

    // flush plugins queued before init (use() before connect); a failing
    // install must not reject ready — it surfaces as an error event.
    const queued = this.#pendingPlugins.splice(0);
    for (const plugin of queued) {
      try {
        editor.use(plugin);
      } catch (err) {
        this.#emitError(
          SceneErrorCode.Lifecycle,
          err instanceof Error ? err.message : "Plugin install failed",
          err,
        );
      }
    }
  }

  /**
   * Announce `model-visibility` when the composite verdict flips. Every input
   * (load, intersection, poster) calls this instead of dispatching directly, so
   * the event always agrees with the `modelIsVisible` getter.
   */
  #syncModelVisibility(): void {
    const visible = this.modelIsVisible;
    if (visible === this.#modelVisible) return;
    this.#modelVisible = visible;
    this.dispatchEvent(new CustomEvent("model-visibility", { detail: { visible } }));
  }

  #onVisibilityChange = (visible: boolean): void => {
    const changed = visible !== this.#intersectionVisible;
    this.#intersectionVisible = visible;
    // Off-screen viewers must not burn a frame budget. Applied even when the
    // flag did not change: the observer's first report can be `false`, and the
    // initial state is already `false` — the render loop still has to stop.
    this.#visibilityPaused = !visible;
    this.#setRenderingPaused();
    if (!changed) return;
    this.dispatchEvent(new CustomEvent("visibility-change", { detail: { visible } }));
    // The viewer-compatible signal is the composite one, not the raw crossing.
    this.#syncModelVisibility();
    if (visible && this.#deferredSrcLoad) this.#maybeLoadSrc();
  };

  /**
   * Two independent reasons to stop drawing: the element scrolled out of view,
   * and the tab went to the background. The runtime sees one boolean.
   */
  #setRenderingPaused(): void {
    const paused = this.#tabHidden || this.#visibilityPaused;
    if (paused === this.#renderPaused) return;
    this.#renderPaused = paused;
    this.#editor?.runtime.setRenderingPaused?.(paused);
  }

  #onKeyDown = (event: Event): void => {
    const editor = this.#editor;
    if (!editor) return;
    // Focus domain (D20): ignore keys unless focus is inside this element.
    const active = document.activeElement;
    if (active !== this && !this.contains(active)) return;
    // Editor keys (undo/redo + reserved G/R/S) are authoring commands; a viewer
    // must not swallow them, so the browser keeps the whole key space.
    if (this.mode === "editor") editor.handleKeyDown(event as KeyboardEvent);
    // Viewer navigation is the fallback for keys the editor did not claim, so a
    // host with edit shortcuts never loses them to camera keys.
    const key = event as KeyboardEvent;
    if (!key.defaultPrevented) this.#handleViewerKey(key);
  };

  /**
   * model-viewer's keyboard camera: arrows orbit, +/- dolly, Shift = fine step.
   *
   * Mirrors what a drag does — the pose changes on the runtime only, so no
   * document is dirtied and no `view-change` fires (that event is for gestures;
   * `camera-change` still samples the new pose).
   */
  #handleViewerKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    const orbit = this.getCameraOrbit();
    if (orbit === null) return;
    const step = event.shiftKey ? 1 : 5;
    let next: Partial<CameraOrbit> | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = { theta: orbit.theta - step };
        break;
      case "ArrowRight":
        next = { theta: orbit.theta + step };
        break;
      case "ArrowUp":
        next = { phi: orbit.phi - step };
        break;
      case "ArrowDown":
        next = { phi: orbit.phi + step };
        break;
      case "+":
      case "=":
        next = { radius: orbit.radius * 0.9 };
        break;
      case "-":
      case "_":
        next = { radius: orbit.radius * 1.1 };
        break;
      default:
        return;
    }
    event.preventDefault();
    this.setCameraOrbit(next);
    // A key is a first gesture too: it reveals an `interaction`-mode poster,
    // exactly as a pointerdown would.
    this.#slots.dismissPoster("interaction");
  }

  #emitError(code: string, message: string, cause?: unknown): void {
    const detail: { code: string; message: string; cause?: unknown } = { code, message };
    if (cause !== undefined) detail.cause = cause;
    // Same visual contract as the facade's `error` event: never a bare event.
    this.#slots.showError(message);
    this.dispatchEvent(new CustomEvent("error", { detail }));
  }

  // Typed listener surface: `el.addEventListener("view-change", e => e.detail.view)`
  // without casts. Falls back to the standard signature for anything else.
  addEventListener<K extends keyof SceneEditorElementEventMap>(
    type: K,
    listener: (
      this: SceneEditorElement,
      event: CustomEvent<SceneEditorElementEventMap[K]>,
    ) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    // `never` in the parameter position accepts the narrower CustomEvent
    // listeners above while keeping the DOM overload assignable.
    listener:
      | ((this: SceneEditorElement, event: never) => void)
      | EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }
}
