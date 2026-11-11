import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  CameraOrbitLimits,
  DisplayModeId,
  EnvironmentPreset,
  RuntimeContract,
  ToneMappingMode,
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

const TONE_MAPPING_MODES: readonly ToneMappingMode[] = [
  "none",
  "linear",
  "aces",
  "agx",
  "neutral",
];

function normalizeToneMapping(value: string): ToneMappingMode | null {
  const lower = value.toLowerCase();
  return (TONE_MAPPING_MODES as readonly string[]).includes(lower)
    ? (lower as ToneMappingMode)
    : null;
}

const DISPLAY_MODE_IDS: readonly DisplayModeId[] = [
  "studio",
  "xray",
  "wireframe",
  "normal",
  "clay",
];

/** `display-mode`; invalid spellings are ignored (not guessed into a mode). */
function displayModeFrom(value: string | null): DisplayModeId | null {
  if (value === null) return null;
  const lower = value.trim().toLowerCase();
  return (DISPLAY_MODE_IDS as readonly string[]).includes(lower)
    ? (lower as DisplayModeId)
    : null;
}

/** `explode` as 0..1; `null` (absent) means 0, invalid text means 0. */
function explodeFrom(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

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

/**
 * `touch-action` values a viewer may hand to the browser. `auto` is
 * deliberately absent: model-viewer's docs treat "the CSS default" as "do not
 * opt into camera interaction at all", and `auto` on the canvas is what causes
 * the scroll hijack this attribute exists to prevent.
 */
const TOUCH_ACTION_KEYWORDS: ReadonlySet<string> = new Set(["none", "pan-x", "pan-y"]);

/**
 * model-viewer's default: one-finger vertical drags scroll the page, and a
 * drag that starts horizontally still orbits (`pan-y` allows the latter).
 */
const DEFAULT_TOUCH_ACTION = "pan-y";

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

/* ---------------------------------------------------------------- slots ---- */

/**
 * Light-DOM slots (no shadow root). model-viewer puts these names on `<slot>`s
 * inside its shadow tree; this element honours the same `slot` attribute on
 * plain children, which keeps `querySelector` / `:scope > ...` working for hosts
 * and for the e2e suites.
 */
const SLOT_POSTER = "poster";
const SLOT_PROGRESS = "progress-bar";
const SLOT_ERROR = "error";
const HOTSPOT_PREFIX = "hotspot-";

/**
 * `seamless-poster` fade duration (model-viewer's own poster transition is
 * 300ms). Long enough to hide the first-frame pop, short enough that the poster
 * is not still visible when a host starts an intro animation.
 */
const POSTER_FADE_MS = 300;

type RevealMode = "auto" | "interaction" | "manual";
const REVEAL_MODES: ReadonlySet<string> = new Set<RevealMode>(["auto", "interaction", "manual"]);

/** The slot families this element styles itself (no shadow root). */
type SlotRole = "poster" | "progress" | "hotspot" | "error";

/** `<scene-editor mode="viewer">` vs `mode="editor"` (see `SceneEditorElement.mode`). */
export type SceneEditorMode = "viewer" | "editor";

/**
 * A `slot="hotspot-*"` anchor, plus what this element projects onto it.
 *
 * `data-position` is world space (what `positionAndNormalFromPoint()` hands
 * back), `data-normal` defaults to `+Y` — model-viewer's own default, so an
 * anchor that never declares a normal is always considered facing.
 */
interface HotspotAnchor {
  el: HTMLElement;
  /** The slot name, which is also the key `queryHotspot()` looks up. */
  name: string;
  position: [number, number, number];
  normal: [number, number, number];
  /** `data-visibility-attribute`: mirror the verdict onto `data-<value>`. */
  visibilityAttr: string | null;
  /** Last verdict, so `hotspot-visibility` fires on change instead of per frame. */
  facing: boolean | null;
}

const ORBIT_AXES = ["theta", "phi", "radius"] as const;

/** 0..1 range for opacity-like attributes; `NaN` collapses to 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/** `data-position="1 2 3"` → tuple, or `null` when the attribute is unusable. */
function parseVector3(raw: string | null): [number, number, number] | null {
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 3) return null;
  const values = parts.map((part) => Number.parseFloat(part));
  if (values.some((value) => !Number.isFinite(value))) return null;
  return [values[0] as number, values[1] as number, values[2] as number];
}

/** model-viewer's `auto` placeholder, `90deg`, `1.2rad`, or a bare number. */
function parseOrbitToken(
  raw: string | undefined,
  axis: (typeof ORBIT_AXES)[number],
): number | undefined {
  if (raw === undefined) return undefined;
  const token = raw.trim().toLowerCase();
  if (token === "" || token === "auto") return undefined;
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) return undefined;
  if (axis === "radius") return value;
  // Angles: `rad` converts, `deg` and unitless are already degrees.
  return token.endsWith("rad") ? (value * 180) / Math.PI : value;
}

function readOrbitLimits(el: HTMLElement): CameraOrbitLimits | undefined {
  const minRaw = el.getAttribute("min-camera-orbit");
  const maxRaw = el.getAttribute("max-camera-orbit");
  if (minRaw === null && maxRaw === null) return undefined;

  const minTokens = (minRaw ?? "").trim().split(/\s+/);
  const maxTokens = (maxRaw ?? "").trim().split(/\s+/);
  const limits: CameraOrbitLimits = {};
  for (const [index, axis] of ORBIT_AXES.entries()) {
    const low = parseOrbitToken(minTokens[index], axis);
    const high = parseOrbitToken(maxTokens[index], axis);
    // `auto` on either side means "unlimited" — a half-open range is not a range.
    if (low === undefined || high === undefined || low > high) continue;
    limits[axis] = [low, high] as const;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function readNumberAttr(el: HTMLElement, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** model-viewer's `interpolation-decay` default, in milliseconds. */
const DEFAULT_INTERPOLATION_DECAY = 50;

/** The camera half of a view state, as the runtime and rig hand it around. */
type CameraView = ViewState["camera"];

/* ------------------------------------------------------------ orbit math ---- */

/** model-viewer's orbit triple: azimuth / polar / distance, degrees + world units. */
export interface CameraOrbit {
  /** Azimuth, degrees, measured from +Z toward +X (0 = looking from the front). */
  theta: number;
  /** Polar angle from +Y, degrees (75 = 15° above the horizon). */
  phi: number;
  /** Distance from the orbit target, world units. */
  radius: number;
}

/** A vector in the `{x, y, z}` shape model-viewer's `queryHotspot()` returns. */
export interface HotspotVector {
  x: number;
  y: number;
  z: number;
}

/**
 * What `queryHotspot()` reports — model-viewer's `HotspotData`, field for field.
 *
 * `position` / `normal` are the values declared on the anchor (world space, the
 * same space `positionAndNormalFromPoint()` returns), `canvasPosition` is where
 * the anchor currently sits in canvas-local CSS pixels, and `facingCamera` is
 * the `data-normal` verdict. Deliberately `{x, y, z}` objects rather than this
 * repo's usual tuples, so host code written for model-viewer keeps working.
 */
export interface HotspotData {
  position: HotspotVector;
  normal: HotspotVector;
  /** Canvas pixels plus the projected NDC depth in `z`. */
  canvasPosition: HotspotVector;
  facingCamera: boolean;
}

/**
 * `updateHotspot()` input — model-viewer's `HotspotConfiguration`.
 *
 * The three geometry fields are *strings*, in the same format as the anchor
 * attributes (`data-position` / `data-normal` / `data-surface`), not vectors:
 * a host migrating from model-viewer passes through whatever it stored.
 */
export interface HotspotConfig {
  /**
   * Full slot name, prefix included (`"hotspot-tank"`) — the same key
   * `queryHotspot()` takes, because the reference keys its map by `node.slot`.
   */
  name: string;
  position?: string;
  normal?: string;
  /** Accepted for signature compatibility; surface tracking is not implemented. */
  surface?: string;
  modelIndex?: number;
}

const DEG = Math.PI / 180;
/** Keeps the eye off the pole: `lookAt` is undefined when the offset is vertical. */
const PHI_EPSILON = 0.5;

/**
 * Camera offset → orbit angles. `null` when the eye sits on the target (no
 * direction to speak of), so callers fall back instead of emitting `NaN`.
 *
 * The convention matches `min-camera-orbit` / `max-camera-orbit`: `theta` is the
 * azimuth from +Z toward +X and `phi` the polar angle from +Y — the same frame
 * model-viewer's `camera-orbit` uses, hence the same numbers a host can paste
 * between the two elements.
 */
export function orbitFromCamera(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): CameraOrbit | null {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(radius) || radius < 1e-6) return null;
  const phi = Math.acos(Math.min(Math.max(dy / radius, -1), 1)) / DEG;
  // atan2(x, z): 0° on +Z, +90° on +X.
  const theta = Math.atan2(dx, dz) / DEG;
  return { theta, phi, radius };
}

/** Orbit angles → camera offset from the target. */
export function cameraFromOrbit(
  target: readonly [number, number, number],
  orbit: CameraOrbit,
): [number, number, number] {
  const phi = Math.min(Math.max(orbit.phi, PHI_EPSILON), 180 - PHI_EPSILON) * DEG;
  const theta = orbit.theta * DEG;
  const radius = Math.max(orbit.radius, 1e-6);
  const horizontal = radius * Math.sin(phi);
  return [
    target[0] + horizontal * Math.sin(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + horizontal * Math.cos(theta),
  ];
}

/** `field-of-view="30deg"` → degrees; `auto` / garbage → undefined. */
function parseAngle(raw: string | undefined): number | undefined {
  return parseOrbitToken(raw, "theta");
}

/** OrbitControls' own default `dampingFactor`. */
const DEFAULT_DAMPING = 0.08;

/**
 * `camera-damping="0.08"` → inertia factor. Absent means "no inertia", which is
 * what a render-on-demand editor wants; a bare attribute gets the addon default.
 */
function readDamping(el: HTMLElement): number | undefined {
  if (!el.hasAttribute("camera-damping")) return undefined;
  const raw = Number.parseFloat(el.getAttribute("camera-damping") ?? "");
  return Number.isFinite(raw) ? clamp01(raw) : DEFAULT_DAMPING;
}

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
  #slotsObserver: MutationObserver | null = null;
  /** Slot nodes this element styles, with the inline CSS they arrived with. */
  #slotted: Array<{ el: HTMLElement; cssText: string }> = [];
  #poster: HTMLElement | null = null;
  #progressBar: HTMLElement | null = null;
  #hotspots: HotspotAnchor[] = [];
  /** Inline values to restore when this element stops owning a node's look. */
  readonly #originalDisplay = new WeakMap<HTMLElement, string>();
  readonly #originalVisibility = new WeakMap<HTMLElement, string>();
  /** The poster node currently fading out, if any. */
  #fadingPoster: HTMLElement | null = null;
  /** `seamless-poster` fade in flight; keeps the node mounted until it ends. */
  #posterFadeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Inline opacity each poster arrived with, restored once its fade finishes. */
  readonly #posterOpacity = new WeakMap<HTMLElement, string>();
  /** Poster already dismissed (or never present); `dismissPoster()` flips it. */
  #revealed = true;
  /** `true` while a load is in flight (drives `slot="progress-bar"`). */
  #loading = false;
  /** Content mounted — `reveal="auto"` then dismisses a late poster at once. */
  #contentLoaded = false;
  /* ---------------------------------------------------------- error state ---- */
  /** Last failure message; `null` = healthy (drives `slot="error"`). */
  #errorMessage: string | null = null;
  /** Host-provided `slot="error"` node, when there is one. */
  #errorSlot: HTMLElement | null = null;
  /** Built-in fallback overlay, used only when the host supplied no error slot. */
  #errorOverlay: HTMLElement | null = null;
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

  /* ------------------------------------------------------ playback state ---- */
  /** Set by `pause()`: an explicit transport stop outranks `autoplay` for later loads. */
  #explicitPause = false;
  /** Clip the transport last started/continued; `null` = nothing played yet. */
  #activeClipName: string | null = null;

  /* --------------------------------------------------------- camera pose ---- */
  /** Signature of the last applied `camera-orbit|-target|-field-of-view` triple. */
  #appliedCameraPose: string | null = null;
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
    return this.#contentLoaded && inViewport && this.#revealed;
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
      this.#applyDisplaySettings();
      return;
    }
    if (name === "environment-image" || name === "skybox-image") {
      // Display-only, same as `tone-mapping`: never written to the document.
      this.#applyEnvironmentPreset();
      return;
    }
    if (name === "alt") {
      this.#applyAlt();
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
      this.#applyCameraPose(true);
      return;
    }
    if (CAMERA_ATTRIBUTES.has(name)) {
      this.#applyCameraSettings();
      return;
    }
    if (name === "touch-action") {
      this.#applyTouchAction();
      return;
    }
    if (SENSITIVITY_ATTRIBUTES.has(name)) {
      this.#applyCameraSettings();
      return;
    }
    if (PLAYBACK_ATTRIBUTES.has(name)) {
      this.#applyPlaybackSettings();
      return;
    }
    if (name === "reveal") {
      // `manual` never auto-dismisses; switching back to `auto` after the model
      // is already mounted reveals it immediately.
      if (this.#revealMode === "auto" && this.#contentLoaded) this.#dismissPoster("load");
      else this.#applyPosterVisibility();
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
    this.#resetSlots();
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
    this.#clearError();
    // Editor mode again: back to the warm room unless the host chose otherwise.
    this.#applyEnvironmentPreset();
    this.#setLoading(true);
    performance.mark("scene-editor:load:start");
    try {
      // A host document may reference compressed assets too (the studio's own
      // import path does), so the same bundle is resolved here.
      await this.#prepareDecoders();
      await this.#requireEditor().loadDocument(doc);
      // Same reason as the `src` path: the document's `view` lands after the
      // `load` event, so display-only attributes are re-asserted afterwards.
      this.#reassertDisplaySettings();
    } finally {
      this.#setLoading(false);
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
    const anchor = this.#hotspots.find((entry) => entry.name === name);
    if (!anchor) return null;
    const runtime = this.#editor?.runtime;
    if (!runtime) return null;

    const projected = runtime.projectHotspot
      ? runtime.projectHotspot(anchor.position, anchor.normal)
      : runtime.projectPoint
        ? { ...runtime.projectPoint(anchor.position), facingCamera: true }
        : null;
    if (!projected) return null;
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;

    const [px, py, pz] = anchor.position;
    const [nx, ny, nz] = anchor.normal;
    return {
      position: { x: px, y: py, z: pz },
      normal: { x: nx, y: ny, z: nz },
      canvasPosition: { x: projected.x, y: projected.y, z: projected.z ?? 0 },
      facingCamera: projected.facingCamera,
    };
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
    if (!config || typeof config.name !== "string") return;
    const matches = this.#hotspots.filter((entry) => entry.name === config.name);
    if (matches.length === 0) return;

    const position = parseVector3(config.position ?? null);
    const normal = parseVector3(config.normal ?? null);
    if (position === null && normal === null) return;
    for (const anchor of matches) {
      if (position !== null) anchor.position = [...position];
      if (normal !== null) anchor.normal = [...normal];
    }
    this.#updateHotspots();
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
    this.#dismissPoster("api");
  }

  /** Re-scan `slot="…"` children (call after adding/removing them dynamically). */
  refreshSlots(): void {
    this.#collectSlots();
  }

  /* ------------------------------------------------------------- slots ---- */

  /** `reveal` in canonical form; unknown values behave like the default `auto`. */
  get #revealMode(): RevealMode {
    const raw = (this.getAttribute("reveal") ?? "auto").trim().toLowerCase();
    return (REVEAL_MODES as ReadonlySet<string>).has(raw) ? (raw as RevealMode) : "auto";
  }

  /** Watch light-DOM children for slot nodes added, removed or re-slotted. */
  #observeSlots(): void {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      // The built-in failure overlay is ours, not a slot: writing its message
      // replaces a text node, which lands here as a childList mutation on a
      // descendant. Without this filter the message re-entering `#collectSlots`
      // → `#applyErrorVisibility` → `textContent` spins the microtask queue.
      const overlay = this.#errorOverlay;
      if (overlay && records.every((record) => overlay.contains(record.target))) return;
      this.#collectSlots();
    });
    // `subtree` matters: the anchors are *children*, so without it an anchor
    // that changes its own `data-normal` (a host flipping a label to the back of
    // the model) would never be re-collected. We only ever write `style` and the
    // opted-in `data-<visibility-attribute>`, neither of which is in the filter —
    // no feedback loop.
    observer.observe(this, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ["slot", "data-position", "data-normal", "data-visibility-attribute"],
    });
    this.#slotsObserver = observer;
  }

  /** Re-home `slot="poster" | "progress-bar" | "error" | "hotspot-*"` children. */
  #collectSlots(): void {
    let poster: HTMLElement | null = null;
    let progress: HTMLElement | null = null;
    let error: HTMLElement | null = null;
    const hotspots: HotspotAnchor[] = [];
    const owned: Array<{ el: HTMLElement; role: SlotRole }> = [];

    for (const child of Array.from(this.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const slot = child.getAttribute("slot");
      if (slot === null) continue;
      if (slot === SLOT_POSTER) {
        poster = child;
        owned.push({ el: child, role: "poster" });
        continue;
      }
      if (slot === SLOT_PROGRESS) {
        progress = child;
        owned.push({ el: child, role: "progress" });
        continue;
      }
      if (slot === SLOT_ERROR) {
        error = child;
        owned.push({ el: child, role: "error" });
        continue;
      }
      if (!slot.startsWith(HOTSPOT_PREFIX)) continue;
      const position = parseVector3(child.getAttribute("data-position"));
      if (position === null) continue;
      hotspots.push({
        el: child,
        name: slot,
        position,
        // model-viewer's default: an anchor with no `data-normal` faces +Y and
        // is therefore never dimmed.
        normal: parseVector3(child.getAttribute("data-normal")) ?? [0, 1, 0],
        visibilityAttr: child.getAttribute("data-visibility-attribute"),
        facing: null,
      });
      owned.push({ el: child, role: "hotspot" });
    }

    // A different poster node starts a new reveal cycle (model-viewer shows a
    // replacement poster again), while re-collecting the same node preserves it.
    if (poster !== this.#poster) this.#revealed = poster === null;
    this.#poster = poster;
    this.#progressBar = progress;
    this.#errorSlot = error;
    this.#hotspots = hotspots;

    if (owned.length > 0) this.#ensurePositionedHost();
    this.#syncSlotted(owned);
    this.#applyPosterVisibility();
    this.#applyProgressVisibility();
    this.#applyErrorVisibility();
    this.#updateHotspots();
    // Adding a poster to a loaded element hides the model again (the reference
    // shows a replacement poster for a new reveal cycle), so the verdict moves.
    this.#syncModelVisibility();
  }

  /** Absolute slot chrome needs a positioned containing block (the host). */
  #ensurePositionedHost(): void {
    if (typeof getComputedStyle !== "function") return;
    const position = getComputedStyle(this).position;
    if (position === "" || position === "static") this.style.position = "relative";
  }

  /** Take over new nodes, release departed ones back to their original inline CSS. */
  #syncSlotted(nodes: Array<{ el: HTMLElement; role: SlotRole }>): void {
    const next = new Set(nodes.map((node) => node.el));
    const retained: Array<{ el: HTMLElement; cssText: string }> = [];
    for (const entry of this.#slotted) {
      if (next.has(entry.el)) retained.push(entry);
      else entry.el.style.cssText = entry.cssText;
    }

    const known = new Set(retained.map((entry) => entry.el));
    for (const { el, role } of nodes) {
      if (known.has(el)) continue;
      retained.push({ el, cssText: el.style.cssText });
      this.#applySlotStyles(el, role);
    }
    this.#slotted = retained;
  }

  #applySlotStyles(el: HTMLElement, role: SlotRole): void {
    const { style } = el;
    style.position = "absolute";
    if (role === "poster") {
      style.top = "0";
      style.right = "0";
      style.bottom = "0";
      style.left = "0";
      style.zIndex = "1";
      return;
    }
    if (role === "progress") {
      style.left = "0";
      style.right = "0";
      style.bottom = "0";
      style.zIndex = "2";
      return;
    }
    if (role === "error") {
      // Covers the canvas: on a failure there is nothing else worth showing.
      style.top = "0";
      style.right = "0";
      style.bottom = "0";
      style.left = "0";
      style.zIndex = "4";
      return;
    }
    // Hotspot anchors are placed by `translate(-50%, -50%) translate(x, y)`.
    style.top = "0";
    style.left = "0";
    style.zIndex = "3";
    style.transformOrigin = "center";
  }

  /** Show/hide one slot node without losing its original inline `display`. */
  #setVisible(el: HTMLElement | null, visible: boolean): void {
    if (!el) return;
    let original = this.#originalDisplay.get(el);
    if (original === undefined) {
      original = el.style.display;
      this.#originalDisplay.set(el, original);
    }
    el.style.display = visible ? original : "none";
  }

  #applyPosterVisibility(): void {
    const poster = this.#poster;
    if (!poster) return;
    if (!this.#revealed) {
      // A new reveal cycle: undo a fade that is still in flight.
      this.#cancelPosterFade();
      this.#setVisible(poster, true);
      return;
    }
    // `seamless-poster` keeps the node mounted through a fade so the first
    // rendered frame cross-dissolves out of it instead of popping in.
    if (this.#fadeable() && poster.style.display !== "none") {
      this.#fadePosterOut(poster);
      return;
    }
    this.#setVisible(poster, false);
  }

  /** `seamless-poster` is opt-in: without it the poster is cut, as before. */
  #fadeable(): boolean {
    return this.hasAttribute("seamless-poster") && typeof setTimeout === "function";
  }

  #fadePosterOut(poster: HTMLElement): void {
    const { style } = poster;
    this.#cancelPosterFade();
    this.#posterOpacity.set(poster, style.opacity);
    this.#fadingPoster = poster;
    // Passive while fading: the model behind is already interactive.
    style.pointerEvents = "none";
    style.transition = `opacity ${POSTER_FADE_MS}ms ease`;
    style.opacity = "0";
    this.#posterFadeTimer = setTimeout(() => {
      this.#posterFadeTimer = null;
      const node = this.#fadingPoster;
      this.#fadingPoster = null;
      if (!node) return;
      // The node may have been replaced or detached mid-fade.
      if (this.#poster === node) this.#setVisible(node, false);
      this.#restorePosterStyle(node);
    }, POSTER_FADE_MS);
  }

  /** Drop a fade in flight and hand the node's own style back to it. */
  #cancelPosterFade(): void {
    if (this.#posterFadeTimer !== null) {
      clearTimeout(this.#posterFadeTimer);
      this.#posterFadeTimer = null;
    }
    const node = this.#fadingPoster;
    if (!node) return;
    this.#fadingPoster = null;
    this.#restorePosterStyle(node);
  }

  #restorePosterStyle(poster: HTMLElement): void {
    const { style } = poster;
    style.opacity = this.#posterOpacity.get(poster) ?? "";
    style.transition = "";
    style.pointerEvents = "";
  }

  #applyProgressVisibility(): void {
    this.#setVisible(this.#progressBar, this.#loading);
  }

  /**
   * Failure surface. Without it a dead WebGL context or a 404 asset left the
   * host with one `error` event and the user with a blank rectangle.
   */
  #showError(message: string): void {
    this.#errorMessage = message;
    this.#applyErrorVisibility();
  }

  #clearError(): void {
    if (this.#errorMessage === null) return;
    this.#errorMessage = null;
    this.#applyErrorVisibility();
  }

  #applyErrorVisibility(): void {
    const visible = this.#errorMessage !== null;
    const slot = this.#errorSlot;
    if (slot) this.#setVisible(slot, visible);
    const overlay = visible && !slot ? this.#ensureErrorOverlay() : this.#errorOverlay;
    if (overlay) {
      if (visible && !slot) {
        const message = this.#errorMessage ?? "";
        // Only when it changed: a redundant write still replaces the text node,
        // and the mutation observer sees every one of them.
        if (overlay.textContent !== message) overlay.textContent = message;
      }
      this.#setVisible(overlay, visible && !slot);
    }
  }

  /**
   * Built-in fallback text, so "no WebGL" is readable instead of empty. A host
   * that wants its own surface adds a `slot="error"` child; this node is then
   * hidden and never touches the host's DOM.
   */
  #ensureErrorOverlay(): HTMLElement {
    if (this.#errorOverlay) return this.#errorOverlay;
    const node = document.createElement("div");
    node.setAttribute("data-scene-editor-error", "");
    // Announced, not just painted: a screen reader user gets the reason too.
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    Object.assign(node.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      boxSizing: "border-box",
      font: "13px/1.5 system-ui, -apple-system, sans-serif",
      color: "#f2f4f8",
      background: "rgba(10, 14, 22, 0.82)",
      textAlign: "center",
      zIndex: "4",
      pointerEvents: "none",
    });
    this.#ensurePositionedHost();
    this.appendChild(node);
    this.#errorOverlay = node;
    return node;
  }

  #setLoading(loading: boolean): void {
    if (loading === this.#loading) return;
    this.#loading = loading;
    this.#applyProgressVisibility();
  }

  /** Shared reveal path: `api` always wins, the attribute filters the rest. */
  #dismissPoster(reason: "load" | "interaction" | "api"): void {
    if (reason !== "api") {
      const mode = this.#revealMode;
      if (mode === "manual") return;
      if (reason === "load" && mode !== "auto") return;
      if (reason === "interaction" && mode !== "interaction") return;
    }
    const dismissing = this.#poster !== null && !this.#revealed;
    this.#revealed = true;
    this.#applyPosterVisibility();
    this.#syncModelVisibility();
    if (!dismissing) return;
    this.dispatchEvent(new CustomEvent("poster-dismissed", { detail: {} }));
  }

  /** Glue `hotspot-*` anchors to their world position after camera/resize moves. */
  #updateHotspots(): void {
    if (this.#hotspots.length === 0) return;
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    const projectHotspot = runtime.projectHotspot;
    const projectPoint = runtime.projectPoint;
    if (!projectHotspot && !projectPoint) return;

    for (const anchor of this.#hotspots) {
      const { el, position, normal } = anchor;
      const projected = projectHotspot
        ? projectHotspot.call(runtime, position, normal)
        : { ...projectPoint!.call(runtime, position), facingCamera: true };
      // `visible: false` = behind the camera or outside the depth range.
      this.#setHotspotVisible(el, projected.visible);
      if (projected.visible) {
        el.style.transform = `translate(-50%, -50%) translate(${projected.x}px, ${projected.y}px)`;
      }
      this.#setHotspotFacing(anchor, projected.facingCamera);
    }
  }

  /**
   * Apply a `data-normal` verdict: dim the node the way model-viewer does
   * (`--min-hotspot-opacity`, default `0.25`), mirror the verdict onto
   * `data-<visibility-attribute>` when the host opted in, and announce it.
   *
   * Only runs on a change — the projection above happens every frame, and a
   * `hotspot-visibility` event per frame would be useless noise.
   */
  #setHotspotFacing(anchor: HotspotAnchor, facing: boolean): void {
    if (anchor.facing === facing) return;
    anchor.facing = facing;
    // Facing front removes the inline value rather than writing `1`, so the
    // host's own opacity (or `--max-hotspot-opacity`) still has a say.
    anchor.el.style.opacity = facing ? "" : "var(--min-hotspot-opacity, 0.25)";
    const { visibilityAttr } = anchor;
    if (visibilityAttr) anchor.el.toggleAttribute(`data-${visibilityAttr}`, facing);
    anchor.el.dispatchEvent(
      new CustomEvent("hotspot-visibility", { detail: { visible: facing } }),
    );
  }

  #setHotspotVisible(el: HTMLElement, visible: boolean): void {
    let original = this.#originalVisibility.get(el);
    if (original === undefined) {
      original = el.style.visibility;
      this.#originalVisibility.set(el, original);
    }
    el.style.visibility = visible ? original : "hidden";
  }

  /** Drop the observer and hand every slot node its own inline CSS back. */
  #resetSlots(): void {
    this.#slotsObserver?.disconnect();
    this.#slotsObserver = null;
    // Drop any fade first: the timeout would otherwise restyle a node whose
    // original `cssText` has just been restored below.
    this.#cancelPosterFade();
    for (const entry of this.#slotted) entry.el.style.cssText = entry.cssText;
    this.#slotted = [];
    this.#poster = null;
    this.#progressBar = null;
    this.#errorSlot = null;
    this.#errorMessage = null;
    this.#setVisible(this.#errorOverlay, false);
    this.#hotspots = [];
    this.#loading = false;
    this.#revealed = true;
    this.#contentLoaded = false;
    // Teardown: the model is gone, so a host that parked work on
    // `model-visibility` learns about it instead of waiting forever.
    this.#syncModelVisibility();
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
    this.#clearError();
    this.#srcLoadFailed = false;
    // Hold `load` until `frameViewer()` ran (see `#pendingSrcLoads`).
    this.#pendingSrcLoads += 1;
    this.#deferredLoadDetail = null;
    // Preview mode may have just switched the default preset to `neutral`.
    this.#applyEnvironmentPreset();
    this.#setLoading(true);
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
      this.#reassertDisplaySettings();
    } catch {
      // The facade already emitted `error`; swallowing keeps the
      // fire-and-forget call site free of unhandled rejections.
    } finally {
      // Release the held `load` once the last overlapping load is framed.
      this.#pendingSrcLoads = Math.max(0, this.#pendingSrcLoads - 1);
      if (this.#pendingSrcLoads === 0) this.#flushDeferredLoad();
      this.#setLoading(false);
    }
  }

  /** Dispatch the `load` held back by the `src` path, then dismiss the poster. */
  #flushDeferredLoad(): void {
    const detail = this.#deferredLoadDetail;
    this.#deferredLoadDetail = null;
    if (!detail) return;
    this.dispatchEvent(new CustomEvent("load", { detail }));
    // `reveal="auto"` (the default): the framed model is on screen — drop the poster.
    this.#dismissPoster("load");
  }

  /**
   * Built-in IBL for the current mode. `environment-image` wins; without it a
   * preview is a viewer (model-viewer's neutral studio) while a host-owned
   * document keeps the editor's warm room.
   *
   * `legacy` is model-viewer's old default; here it aliases `room`, which is
   * literally the studio this project used before the `neutral` port.
   */
  get #environmentPreset(): EnvironmentPreset {
    const raw = (this.getAttribute("environment-image") ?? "").trim().toLowerCase();
    if (raw === "neutral" || raw === "room" || raw === "legacy") return raw;
    return this.src !== null && this.#documentOwner !== "host" ? "neutral" : "room";
  }

  /**
   * `environment-image` as a file URL, or `null` when it names a preset (or is
   * unset). model-viewer accepts `neutral`, `legacy` or a URL in the same
   * attribute, so the value's shape — not a separate flag — decides.
   */
  get #environmentImageUrl(): string | null {
    const raw = (this.getAttribute("environment-image") ?? "").trim();
    if (raw === "") return null;
    const lower = raw.toLowerCase();
    return lower === "neutral" || lower === "room" || lower === "legacy" ? null : raw;
  }

  /**
   * Apply the lighting side of `environment-image` / `skybox-image`.
   *
   * Order matters: the preset goes first (it owns the fallback IBL), then the
   * URL override takes the reflection over, then the backdrop — because
   * model-viewer lets a skybox light the model only when no `environment-image`
   * is set, and deciding that needs to see the other attribute.
   */
  #applyEnvironmentPreset(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    runtime.setEnvironmentPreset?.(this.#environmentPreset);
    runtime.setEnvironmentImage?.(this.#environmentImageUrl);
    this.#applySkyboxImage();
  }

  /** `skybox-image`: the visible backdrop, and the IBL too when nothing else is. */
  #applySkyboxImage(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    const url = (this.getAttribute("skybox-image") ?? "").trim() || null;
    runtime.setSkyboxImage?.(url, {
      asEnvironment: url !== null && this.#environmentImageUrl === null,
    });
  }

  /**
   * `alt` — the canvas is the accessible representation of the model
   * (model-viewer parity). Without the attribute the label falls back to the
   * file name, which beats an unlabelled canvas: a screen-reader user then hears
   * *something* instead of "graphic".
   */
  #applyAlt(): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    canvas.setAttribute("role", "img");
    const text = this.getAttribute("alt")?.trim() || this.#fallbackAlt();
    if (text) canvas.setAttribute("aria-label", text);
    else canvas.removeAttribute("aria-label");
  }

  #fallbackAlt(): string {
    const name = this.src?.split(/[?#]/)[0]?.split("/").pop() ?? "";
    return name ? `3D model: ${name}` : "";
  }

  /**
   * Display-only settings. `src` previews default to `neutral` because that is
   * what model-viewer's `tone-mapping="auto"` resolves to on a glTF asset
   * (measured: identical mean/p95 luminance on the Khronos Fox, while ACES
   * renders ~35% darker and more saturated). Documents loaded through
   * `loadDocument()` keep three's default unless the host opts in.
   */
  #applyDisplaySettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    const mode = this.getAttribute("tone-mapping") ?? (this.src ? "neutral" : null);
    if (mode) {
      const normalized = normalizeToneMapping(mode);
      if (normalized) runtime.setToneMapping?.(normalized);
    }

    const rawExposure = this.getAttribute("exposure");
    if (rawExposure !== null) {
      const exposure = Number(rawExposure);
      if (Number.isFinite(exposure)) runtime.setExposure?.(exposure);
    }

    // Shading overlay + component explode: both presentation-only, both
    // re-asserted after a load (the runtime resets explode on document swap).
    const rawMode = this.getAttribute("display-mode");
    runtime.setDisplayMode?.(displayModeFrom(rawMode) ?? "studio");
    runtime.setExplode?.(explodeFrom(this.getAttribute("explode")));

    this.#applyShadowSettings();
    this.#applyVariantName();
    // An authored camera is a complete pose, so it gets the first word;
    // `#applyCameraPose` stands down while one is selected.
    this.#applyCameraName();
    this.#applyCameraPose();
  }

  /**
   * Re-run the display settings after a load. Unlike the attribute path this
   * also forgets the applied camera pose: the document's own `view` is restored
   * after the `load` event, which silently overwrites whatever the attributes
   * applied before it.
   */
  #reassertDisplaySettings(): void {
    // Forget the applied pose so the post-load application snaps to the
    // document's own `view` instead of fading toward it.
    this.#appliedCameraPose = null;
    this.#applyDisplaySettings();
  }

  /**
   * `camera-orbit` / `camera-target` / `field-of-view` — model-viewer's
   * declarative pose.
   *
   * Only the axes a host actually spells out are touched: `camera-orbit="auto
   * auto 2m"` keeps the current angles and just moves the eye, which is what
   * `auto` means in model-viewer. The pose goes through `applyViewState` on the
   * *runtime*, never the document — a viewer attribute must not dirty the scene
   * (the persisted pose stays `view.camera`).
   *
   * `force` is what keeps the two paths apart: an attribute *change* always
   * applies, while the post-load re-assert applies once and then stands down, so
   * an unrelated `tone-mapping` tweak cannot snap a user's drag back.
   */
  #applyCameraPose(force = false): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    // `camera-name` owns the whole pose while it is set.
    if (this.cameraName !== null) return;

    const orbitRaw = this.getAttribute("camera-orbit");
    const targetRaw = this.getAttribute("camera-target");
    const fovRaw = this.getAttribute("field-of-view");
    if (orbitRaw === null && targetRaw === null && fovRaw === null) {
      this.#appliedCameraPose = null;
      return;
    }
    const signature = `${orbitRaw ?? ""}|${targetRaw ?? ""}|${fovRaw ?? ""}`;
    if (!force && signature === this.#appliedCameraPose) return;
    this.#appliedCameraPose = signature;

    const view = runtime.getViewState();
    const camera = {
      position: [...view.camera.position] as [number, number, number],
      target: [...view.camera.target] as [number, number, number],
      fov: view.camera.fov,
    };
    const targetValue = parseVector3(targetRaw);
    const target = targetValue ?? camera.target;
    const current = orbitFromCamera(camera.position, camera.target);

    const tokens = (orbitRaw ?? "").trim().split(/\s+/);
    const theta = orbitRaw === null ? undefined : parseOrbitToken(tokens[0], "theta");
    const phi = orbitRaw === null ? undefined : parseOrbitToken(tokens[1], "phi");
    const radius = orbitRaw === null ? undefined : parseOrbitToken(tokens[2], "radius");
    const targetGiven = targetValue !== null;

    if (theta !== undefined || phi !== undefined || radius !== undefined) {
      // Nothing framed yet (an empty scene): assume the reference's default
      // front view rather than inventing `NaN`s.
      const base = current ?? { theta: 0, phi: 75, radius: 1 };
      camera.position = cameraFromOrbit(target, {
        theta: theta ?? base.theta,
        phi: phi ?? base.phi,
        radius: radius ?? base.radius,
      });
      camera.target = target;
    } else if (targetGiven) {
      // Target alone: keep the angles, translate the eye with it.
      if (current) camera.position = cameraFromOrbit(target, current);
      camera.target = target;
    }

    const fov = parseAngle(fovRaw ?? undefined);
    if (fov !== undefined) camera.fov = this.#clampFieldOfView(fov);

    // A post-load re-assert (`force` is false) is the *initial* placement: it
    // snaps. An attribute the host changed afterwards is a user intent, so it
    // fades — that is what model-viewer does with `camera-orbit`.
    this.#commitCamera(view, camera, !force);
  }

  /**
   * Hand a pose to the runtime.
   *
   * model-viewer interpolates any change to `camera-orbit` / `camera-target`
   * (asymptotically, over `interpolation-decay`), but the initial placement
   * after a load snaps: fading in from wherever the camera happened to be would
   * look like an accidental animation on page load.
   *
   * The fade path deliberately does *not* go through `applyViewState`: an eased
   * pose is presentation only, and must not look like a user view change that
   * gets persisted into the document.
   */
  #commitCamera(view: ViewState, camera: CameraView, instant: boolean): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    if (!instant && runtime.smoothViewTo) {
      runtime.smoothViewTo(camera, this.#interpolationDecay);
      return;
    }
    runtime.applyViewState({ ...view, camera });
  }

  /**
   * `interpolation-decay` (ms, model-viewer default 50): how long a camera move
   * takes. Larger = slower; the decay is asymptotic, so most of the motion
   * happens inside this window.
   */
  get #interpolationDecay(): number {
    const raw = Number.parseFloat(this.getAttribute("interpolation-decay") ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERPOLATION_DECAY;
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

  /** `min-field-of-view` / `max-field-of-view`; absent on either side = no clamp. */
  #clampFieldOfView(value: number): number {
    const min = readNumberAttr(this, "min-field-of-view", 0);
    const max = readNumberAttr(this, "max-field-of-view", 0);
    const lower = min > 0 ? min : 0;
    const upper = max > 0 ? max : Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(value, lower), upper);
    return Number.isFinite(clamped) && clamped > 0 ? clamped : value;
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
    this.#commitCamera(view, { ...view.camera, position }, false);
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
    this.#commitCamera(view, { ...view.camera, position, target: nextTarget }, false);
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
    this.#commitCamera(view, { ...view.camera, fov: this.#clampFieldOfView(degrees) }, false);
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

  /**
   * `camera-name` — look through a camera authored inside the asset.
   *
   * Display-only and re-asserted after every load, like `variant-name`: camera
   * names only exist once the asset parses, and a document's own `view` would
   * otherwise win the race and leave the attribute ignored.
   */
  #applyCameraName(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime?.setCameraByName) return;
    const name = this.cameraName;
    // `null` only clears an active camera; it must not reset a restored view.
    if (name === null && runtime.cameraName === null) return;
    runtime.setCameraByName(name);
  }

  /**
   * `variant-name` — a `KHR_materials_variants` pick (model-viewer parity).
   *
   * Display-only: the choice describes how to look at the asset, not what the
   * document contains, so it never reaches the document. Like the shadow knobs it
   * re-runs after every load — variants are only known once the asset parses, and
   * a name set beforehand has to be applied retroactively.
   */
  #applyVariantName(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime?.setVariant) return;
    const raw = this.getAttribute("variant-name");
    const name = raw === null || raw.trim() === "" ? null : raw.trim();
    runtime.setVariant(name);
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
   * `shadow-intensity` / `shadow-softness` — model-viewer's contact shadow knobs.
   *
   * Display-only, so it patches the *runtime* view (`applyViewState` never
   * touches the document). It has to re-run after every load: a document's own
   * `view.environment` wins over whatever was applied before it, which is
   * exactly how the promo page's shadow used to disappear the moment the GLB
   * finished loading.
   */
  #applyShadowSettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;
    const intensityAttr = this.getAttribute("shadow-intensity");
    const softnessAttr = this.getAttribute("shadow-softness");
    if (intensityAttr === null && softnessAttr === null) return;

    const intensity = clamp01(intensityAttr === null ? 1 : Number(intensityAttr));
    const view = runtime.getViewState();
    const environment = { ...view.environment };
    if (intensity <= 0) {
      delete environment.contactShadow;
    } else {
      const softness = Number(softnessAttr ?? 1);
      environment.contactShadow = {
        enabled: true,
        // Straight through: the shadow rig applies the reference's own
        // softness-dependent easing, so a flat fudge factor here would darken
        // the comparison twice.
        opacity: intensity,
        ...(Number.isFinite(softness) ? { softness: clamp01(softness) } : {}),
      };
    }
    runtime.applyViewState({ ...view, environment });
  }

  /**
   * Camera policy: pointer verbs, orbit limits and the turntable. Presentation
   * only — never recorded in the document, so it cannot mark the scene dirty.
   */
  #applyCameraSettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    const limits = readOrbitLimits(this);
    const damping = readDamping(this);
    // `orbit-sensitivity` follows model-viewer: any finite number, negatives
    // invert the drag. A garbage value falls back to 1 rather than freezing.
    const sensitivity = readNumberAttr(this, "orbit-sensitivity", 1);
    // Same contract for the other two verbs — `zoom-sensitivity="0"` freezes
    // the wheel while the drag still orbits.
    const zoomSensitivity = readNumberAttr(this, "zoom-sensitivity", 1);
    const panSensitivity = readNumberAttr(this, "pan-sensitivity", 1);
    runtime.setCameraControls?.({
      pan: !this.hasAttribute("disable-pan"),
      zoom: !this.hasAttribute("disable-zoom"),
      ...(limits === undefined ? {} : { limits }),
      ...(damping === undefined ? {} : { damping }),
      ...(Number.isFinite(sensitivity) ? { sensitivity } : {}),
      ...(Number.isFinite(zoomSensitivity) ? { zoomSensitivity } : {}),
      ...(Number.isFinite(panSensitivity) ? { panSensitivity } : {}),
    });

    runtime.setAutoRotate?.(
      this.hasAttribute("auto-rotate")
        ? {
            enabled: true,
            degreesPerSecond: readNumberAttr(this, "rotation-per-second", 30),
            delayMs: readNumberAttr(this, "auto-rotate-delay", 3000),
          }
        : null,
    );
  }

  /**
   * `touch-action`: mostly DOM. The browser decides whether a drag becomes a
   * page scroll *before* any pointer event reaches us, so there is nothing for
   * the runtime to compute — which is why model-viewer uses this attribute
   * instead of a CSS rule (`touch-action` on the canvas is unreliable on iOS).
   *
   * It still goes through the runtime as well: `OrbitControls` **and**
   * `TransformControls` write `touch-action: none` onto the canvas when they
   * connect, both from async imports whose order is not ours, so a value applied
   * before an addon mounts is silently overwritten. The runtime holds the value
   * against them (see `viewer/touch-action-owner.ts`); this DOM write is what
   * makes the attribute work even before a runtime exists.
   */
  #applyTouchAction(): void {
    const raw = (this.getAttribute("touch-action") ?? "").trim().toLowerCase();
    const value = TOUCH_ACTION_KEYWORDS.has(raw) ? raw : DEFAULT_TOUCH_ACTION;
    const canvas = this.#canvas;
    if (canvas) canvas.style.touchAction = value;
    this.#editor?.runtime.setTouchAction?.(value);
  }

  /** Playback transport (autoplay / clip name / crossfade / one-shot). */
  #applyPlaybackSettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    runtime.setAnimationOptions?.({
      // `pause()` before the content arrives must survive the load: the host
      // asked for a still frame, not for autoplay to win the race.
      autoplay: this.hasAttribute("autoplay") && !this.#explicitPause,
      clipName: this.getAttribute("animation-name"),
      crossfadeSeconds: readNumberAttr(this, "animation-crossfade-duration", 0) / 1000,
      pauseAtEnd: this.hasAttribute("pause-at-end"),
    });
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

  async #init(): Promise<void> {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    try {
      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      this.appendChild(canvas);
      // The canvas is the accessible representation of the model (`alt`).
      this.#canvas = canvas;
      this.#applyAlt();
      // DOM-only, so it lands before the runtime exists. Also the reason an
      // attribute set before upgrade still takes effect: nothing to re-assert.
      this.#applyTouchAction();
      const assetResolver = this.#createAssetResolver();
      const environmentPreset = this.#environmentPreset;
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
      // Attributes set before upgrade land here: observedAttributes fires during
      // upgrade, but the runtime only exists now.
      runtime.setLiveViewEvents?.(this.#liveViewEvents);
      runtime.setEnvironmentPreset?.(environmentPreset);
      // The default factory already got this; repeating it covers a custom
      // factory that dropped the option (and is a no-op when it did not).
      runtime.setInstancing?.(instancing);
      this.#applyDisplaySettings();
      // Attributes set before upgrade land here (observedAttributes already ran).
      this.#applyCameraSettings();
      this.#applyPlaybackSettings();
      // The factory already got the preset, but the URL overrides and the
      // skybox only exist as attributes — nothing else applies them.
      this.#applyEnvironmentPreset();
      // Again now that a runtime exists: the canvas alone is not enough, the
      // orbit addon overwrites `touch-action` when it mounts.
      this.#applyTouchAction();
      // Now that a runtime exists, the mode can be pushed to it (the factory
      // already received `interactive`; this applies the derived viewer/editor
      // mode from the connect-time `src` declaration).
      this.#applyMode();

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
        this.#dismissPoster("interaction");
      };
      for (const type of ["pointerdown", "wheel", "touchstart"]) {
        this.addEventListener(type, onFirstInteraction, { signal, passive: true });
      }

      // One TransformControls drag → one undoable command (D15 / P2-T6).
      runtime.events.on("transform-commit", ({ id, from, to }) => {
        editor.applyTransform(id, from, to);
      });

      // resize seam: ThreeRuntime exposes resize(); FakeRuntime does not (optional).
      const maybeResize = runtime as { resize?: (w?: number, h?: number) => void };
      const applySize = (): void => {
        maybeResize?.resize?.(this.clientWidth, this.clientHeight);
        // Hotspot anchors are canvas-local pixels: re-project after a resize.
        this.#updateHotspots();
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

      // Facade events → DOM CustomEvents (element public contract, D18/D20).
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
        this.#updateHotspots();
      });
      editor.on("environment-change", (payload) => {
        this.dispatchEvent(new CustomEvent("environment-change", { detail: payload }));
      });
      editor.on("progress", (payload) => {
        // Any progress sample means a load is in flight → show the progress bar.
        this.#setLoading(true);
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
          this.#setLoading(false);
          this.#syncModelVisibility();
          this.#updateHotspots();
          return;
        }
        // Only the `src` path knows a URL; headless/host documents report null.
        const url = this.#documentOwner === "src" ? this.src : null;
        this.#contentLoaded = true;
        this.#setLoading(false);
        this.#clearError();
        const detail = { ...payload, url };
        if (this.#pendingSrcLoads > 0) {
          // Hold the event back: `frameViewer()` has not run yet, so a host
          // reading `getDimensions()` or the camera here would see pre-fit state.
          // Only the load that drains the counter to zero releases the event.
          this.#deferredLoadDetail = detail;
          this.#syncModelVisibility();
          this.#updateHotspots();
          return;
        }
        this.dispatchEvent(new CustomEvent("load", { detail }));
        this.#syncModelVisibility();
        this.#updateHotspots();
        // `reveal="auto"` (the default): the model is on screen — drop the poster.
        this.#dismissPoster("load");
      });
      editor.on("error", (payload) => {
        this.#setLoading(false);
        // The event alone left hosts with a blank canvas; the message is now
        // also a visual state (`slot="error"`, or the built-in overlay).
        this.#showError(payload.message);
        // A preview owns exactly one asset: remember that this load produced
        // nothing, so the `load` that follows cannot announce success.
        if (this.#documentOwner === "src") this.#srcLoadFailed = true;
        this.dispatchEvent(new CustomEvent("error", { detail: payload }));
      });

      this.addEventListener("keydown", this.#onKeyDown, { signal });

      // Slots live in the light DOM (no shadow root): adopt whatever is already
      // there, then keep watching for later additions.
      this.#observeSlots();
      this.#collectSlots();

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
    this.#dismissPoster("interaction");
  }

  #emitError(code: string, message: string, cause?: unknown): void {
    const detail: { code: string; message: string; cause?: unknown } = { code, message };
    if (cause !== undefined) detail.cause = cause;
    // Same visual contract as the facade's `error` event: never a bare event.
    this.#showError(message);
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
