import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  CameraOrbitLimits,
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
import { createResolverAssetLoader } from "../assets/resolver-asset-loader";
import { AssetCache } from "../assets/asset-cache";
import type { MinimalGltfLoader } from "../assets/gltf-asset-loader";
import type { Command } from "../core/history/command-history";
import {
  createSceneEditor,
  type SceneEditor,
  type SceneEditorElementEventMap,
} from "../runtime/create-scene-editor";
import { createSrcDocument, SRC_ASSET_ID } from "./src-document";

export interface RuntimeFactoryOptions {
  /** Host asset resolver (design §10); default factory builds an AssetCache from it. */
  assetResolver?: AssetResolver;
  /** Built-in studio IBL, derived from `environment-image` (default `"room"`). */
  environmentPreset?: EnvironmentPreset;
}

export type SceneEditorRuntimeFactory = (
  canvas: HTMLCanvasElement,
  options?: RuntimeFactoryOptions,
) => RuntimeContract;

/** GLTFLoader is code-split so element-entry stays lean; loadAsync resolves on first use. */
function lazyGltfLoader(): MinimalGltfLoader {
  let pending: Promise<{ loadAsync(url: string): Promise<{ scene: unknown }> }> | null = null;
  const load = (): Promise<{ loadAsync(url: string): Promise<{ scene: unknown }> }> =>
    (pending ??= import("three/examples/jsm/loaders/GLTFLoader.js").then(
      (m) => new m.GLTFLoader(),
    ));
  return {
    loadAsync: async (url) => (await load()).loadAsync(url),
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

/** Attributes that only steer the orbit controls (never persisted, never dirty). */
const CAMERA_ATTRIBUTES: ReadonlySet<string> = new Set([
  "auto-rotate",
  "auto-rotate-delay",
  "rotation-per-second",
  "min-camera-orbit",
  "max-camera-orbit",
  "disable-pan",
  "disable-zoom",
]);

/** Attributes that only steer animation playback (viewer chrome, not the document). */
const PLAYBACK_ATTRIBUTES: ReadonlySet<string> = new Set([
  "autoplay",
  "animation-name",
  "animation-crossfade-duration",
  "pause-at-end",
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
const HOTSPOT_PREFIX = "hotspot-";

type RevealMode = "auto" | "interaction" | "manual";
const REVEAL_MODES: ReadonlySet<string> = new Set<RevealMode>(["auto", "interaction", "manual"]);

/** The three slot families this element styles itself (no shadow root). */
type SlotRole = "poster" | "progress" | "hotspot";

const ORBIT_AXES = ["theta", "phi", "radius"] as const;

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
          }),
        )
      : undefined;
    return new ThreeRuntime({
      canvas,
      ...(assetCache ? { assetCache } : {}),
      ...(options?.environmentPreset ? { environmentPreset: options.environmentPreset } : {}),
    });
  };

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
      "src",
      "loading",
      "reveal",
      "environment-image",
      "tone-mapping",
      "exposure",
      ...CAMERA_ATTRIBUTES,
      ...PLAYBACK_ATTRIBUTES,
    ];
  }

  /** Host-provided asset resolution — set before connect/ready. */
  assetResolver: AssetResolver | null = null;

  /**
   * Preview source (`glb` / `gltf`). When present and the host has not called
   * `loadDocument()`, the element synthesizes a one-mesh document for it.
   */
  get src(): string | null {
    const value = this.getAttribute("src");
    return value ? value : null;
  }

  set src(value: string | null) {
    if (value) this.setAttribute("src", value);
    else this.removeAttribute("src");
  }

  #editor: SceneEditor | null = null;
  #visibilityObserver: VisibilityObserver | null = null;
  #intersectionVisible = false;
  #liveViewEvents = false;
  /** `loading="lazy"` deferred the initial `src` load until first visibility. */
  #deferredSrcLoad = false;
  /** Who owns the document: declarative `src` or an explicit `loadDocument()`. */
  #documentOwner: "host" | "src" | null = null;
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
  #hotspots: Array<{ el: HTMLElement; position: [number, number, number] }> = [];
  /** Inline values to restore when this element stops owning a node's look. */
  readonly #originalDisplay = new WeakMap<HTMLElement, string>();
  readonly #originalVisibility = new WeakMap<HTMLElement, string>();
  /** Poster already dismissed (or never present); `dismissPoster()` flips it. */
  #revealed = true;
  /** `true` while a load is in flight (drives `slot="progress-bar"`). */
  #loading = false;
  /** Content mounted — `reveal="auto"` then dismisses a late poster at once. */
  #contentLoaded = false;

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

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "live-view-events") {
      this.#liveViewEvents = value !== null;
      this.#editor?.runtime.setLiveViewEvents?.(this.#liveViewEvents);
      return;
    }
    if (name === "tone-mapping" || name === "exposure") {
      this.#applyDisplaySettings();
      return;
    }
    if (name === "environment-image") {
      // Display-only, same as `tone-mapping`: never written to the document.
      this.#applyEnvironmentPreset();
      return;
    }
    if (CAMERA_ATTRIBUTES.has(name)) {
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
    if (name === "src" && this.#editor) {
      // Changing `src` is an explicit switch back to preview mode: the host
      // asked for this model, so it wins over a previously loaded document.
      this.#applyDisplaySettings();
      this.#maybeLoadSrc(true);
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
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#visibilityObserver?.disconnect();
    this.#visibilityObserver = null;
    this.#intersectionVisible = false;
    this.#deferredSrcLoad = false;
    this.#pendingPlugins.length = 0;
    this.#resetSlots();
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
    // Editor mode again: back to the warm room unless the host chose otherwise.
    this.#applyEnvironmentPreset();
    this.#setLoading(true);
    performance.mark("scene-editor:load:start");
    try {
      await this.#requireEditor().loadDocument(doc);
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
    const observer = new MutationObserver(() => {
      this.#collectSlots();
    });
    // We only ever write `style`, which is not in the filter — no feedback loop.
    observer.observe(this, {
      childList: true,
      attributes: true,
      attributeFilter: ["slot", "data-position"],
    });
    this.#slotsObserver = observer;
  }

  /** Re-home `slot="poster" | "progress-bar" | "hotspot-*"` children, then paint. */
  #collectSlots(): void {
    let poster: HTMLElement | null = null;
    let progress: HTMLElement | null = null;
    const hotspots: Array<{ el: HTMLElement; position: [number, number, number] }> = [];
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
      if (!slot.startsWith(HOTSPOT_PREFIX)) continue;
      const position = parseVector3(child.getAttribute("data-position"));
      if (position === null) continue;
      hotspots.push({ el: child, position });
      owned.push({ el: child, role: "hotspot" });
    }

    // A different poster node starts a new reveal cycle (model-viewer shows a
    // replacement poster again), while re-collecting the same node preserves it.
    if (poster !== this.#poster) this.#revealed = poster === null;
    this.#poster = poster;
    this.#progressBar = progress;
    this.#hotspots = hotspots;

    if (owned.length > 0) this.#ensurePositionedHost();
    this.#syncSlotted(owned);
    this.#applyPosterVisibility();
    this.#applyProgressVisibility();
    this.#updateHotspots();
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
    this.#setVisible(this.#poster, !this.#revealed);
  }

  #applyProgressVisibility(): void {
    this.#setVisible(this.#progressBar, this.#loading);
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
    if (!dismissing) return;
    this.dispatchEvent(new CustomEvent("poster-dismissed", { detail: {} }));
  }

  /** Glue `hotspot-*` anchors to their world position after camera/resize moves. */
  #updateHotspots(): void {
    if (this.#hotspots.length === 0) return;
    const runtime = this.#editor?.runtime;
    const project = runtime?.projectPoint;
    if (!runtime || !project) return;
    for (const { el, position } of this.#hotspots) {
      const projected = project.call(runtime, position);
      // `visible: false` = behind the camera or outside the depth range.
      this.#setHotspotVisible(el, projected.visible);
      if (projected.visible) {
        el.style.transform = `translate(-50%, -50%) translate(${projected.x}px, ${projected.y}px)`;
      }
    }
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
    for (const entry of this.#slotted) entry.el.style.cssText = entry.cssText;
    this.#slotted = [];
    this.#poster = null;
    this.#progressBar = null;
    this.#hotspots = [];
    this.#loading = false;
    this.#revealed = true;
    this.#contentLoaded = false;
  }

  #requireEditor(): SceneEditor {
    if (!this.#editor) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor not initialized");
    }
    return this.#editor;
  }

  /** Identity resolver for `<scene-editor src>`; only the reserved id resolves. */
  #createSrcResolver(): AssetResolver | null {
    if (!this.src) return null;
    return {
      resolve: async (assetId) => {
        if (assetId !== SRC_ASSET_ID) {
          throw new Error(`Unknown asset: ${assetId}`);
        }
        const src = this.src;
        if (!src) throw new Error("src is no longer set");
        return src;
      },
    };
  }

  async #loadSrc(): Promise<void> {
    const editor = this.#editor;
    const src = this.src;
    if (!editor || !src) return;
    this.#deferredSrcLoad = false;
    this.#documentOwner = "src";
    this.#contentLoaded = false;
    // Preview mode may have just switched the default preset to `neutral`.
    this.#applyEnvironmentPreset();
    this.#setLoading(true);
    try {
      await editor.loadDocument(createSrcDocument(src));
      // Viewer framing (model-viewer parity); a plain fit is the fallback.
      const runtime = editor.runtime;
      if (runtime.frameViewer) runtime.frameViewer();
      else runtime.autoFrame?.();
    } catch {
      // The facade already emitted `error`; swallowing keeps the
      // fire-and-forget call site free of unhandled rejections.
    } finally {
      this.#setLoading(false);
    }
  }

  /**
   * Built-in IBL for the current mode. `environment-image` wins; without it a
   * preview is a viewer (model-viewer's neutral studio) while a host-owned
   * document keeps the editor's warm room.
   */
  get #environmentPreset(): EnvironmentPreset {
    const raw = (this.getAttribute("environment-image") ?? "").trim().toLowerCase();
    if (raw === "neutral" || raw === "room") return raw;
    return this.src !== null && this.#documentOwner !== "host" ? "neutral" : "room";
  }

  #applyEnvironmentPreset(): void {
    this.#editor?.runtime.setEnvironmentPreset?.(this.#environmentPreset);
  }

  /**
   * Display-only settings. `src` previews default to ACES because raw linear
   * output looks flat for arbitrary glTF assets; documents loaded through
   * `loadDocument()` keep three's default unless the host opts in.
   */
  #applyDisplaySettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    const mode = this.getAttribute("tone-mapping") ?? (this.src ? "aces" : null);
    if (mode) {
      const normalized = normalizeToneMapping(mode);
      if (normalized) runtime.setToneMapping?.(normalized);
    }

    const rawExposure = this.getAttribute("exposure");
    if (rawExposure !== null) {
      const exposure = Number(rawExposure);
      if (Number.isFinite(exposure)) runtime.setExposure?.(exposure);
    }
  }

  /**
   * Camera policy: pointer verbs, orbit limits and the turntable. Presentation
   * only — never recorded in the document, so it cannot mark the scene dirty.
   */
  #applyCameraSettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    const limits = readOrbitLimits(this);
    runtime.setCameraControls?.({
      pan: !this.hasAttribute("disable-pan"),
      zoom: !this.hasAttribute("disable-zoom"),
      ...(limits === undefined ? {} : { limits }),
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

  /** Playback transport (autoplay / clip name / crossfade / one-shot). */
  #applyPlaybackSettings(): void {
    const runtime = this.#editor?.runtime;
    if (!runtime) return;

    runtime.setAnimationOptions?.({
      autoplay: this.hasAttribute("autoplay"),
      clipName: this.getAttribute("animation-name"),
      crossfadeSeconds: readNumberAttr(this, "animation-crossfade-duration", 0) / 1000,
      pauseAtEnd: this.hasAttribute("pause-at-end"),
    });
  }

  /**
   * Load the declarative `src` now — unless `loading="lazy"` and the element is
   * still off-screen. Without an IntersectionObserver there is no "visible"
   * moment to wait for, so the load stays eager.
   */
  #maybeLoadSrc(force = false): void {
    if (!this.src) return;
    // A host-owned document outranks the declarative attribute — except when the
    // host itself changed `src`, which is an explicit switch back to preview.
    if (!force && this.#documentOwner === "host") return;
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
      const assetResolver = this.assetResolver ?? this.#createSrcResolver();
      const environmentPreset = this.#environmentPreset;
      const runtime = SceneEditorElement.runtimeFactory(canvas, {
        ...(assetResolver ? { assetResolver } : {}),
        environmentPreset,
      });
      const editor = createSceneEditor({ runtime });
      this.#editor = editor;
      // Attributes set before upgrade land here: observedAttributes fires during
      // upgrade, but the runtime only exists now.
      runtime.setLiveViewEvents?.(this.#liveViewEvents);
      runtime.setEnvironmentPreset?.(environmentPreset);
      this.#applyDisplaySettings();
      // Attributes set before upgrade land here (observedAttributes already ran).
      this.#applyCameraSettings();
      this.#applyPlaybackSettings();

      // Click-to-select (P2-T7): pick on canvas click, empty → clear.
      // Shift / Ctrl / Cmd makes the click additive (toggle), matching the
      // facade's multi-select surface (`add` / `remove` / `toggle`).
      const onClick = (event: MouseEvent): void => {
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
      const onFirstInteraction = (): void => this.#dismissPoster("interaction");
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
      editor.on("load", (payload) => {
        // Only the `src` path knows a URL; headless/host documents report null.
        const url = this.#documentOwner === "src" ? this.src : null;
        this.#contentLoaded = true;
        this.#setLoading(false);
        this.dispatchEvent(new CustomEvent("load", { detail: { ...payload, url } }));
        this.#updateHotspots();
        // `reveal="auto"` (the default): the model is on screen — drop the poster.
        this.#dismissPoster("load");
      });
      editor.on("error", (payload) => {
        this.#setLoading(false);
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

  #onVisibilityChange = (visible: boolean): void => {
    if (visible === this.#intersectionVisible) return;
    this.#intersectionVisible = visible;
    this.dispatchEvent(new CustomEvent("visibility-change", { detail: { visible } }));
    // Viewer-compatible alias (model-viewer `model-visibility`).
    this.dispatchEvent(new CustomEvent("model-visibility", { detail: { visible } }));
    if (visible && this.#deferredSrcLoad) this.#maybeLoadSrc();
  };

  #onKeyDown = (event: Event): void => {
    const editor = this.#editor;
    if (!editor) return;
    // Focus domain (D20): ignore keys unless focus is inside this element.
    const active = document.activeElement;
    if (active !== this && !this.contains(active)) return;
    // Key semantics (undo/redo + reserved G/R/S) are shared with the headless
    // facade; this only decides whether the element owns the keystroke.
    editor.handleKeyDown(event as KeyboardEvent);
  };

  #emitError(code: string, message: string, cause?: unknown): void {
    const detail: { code: string; message: string; cause?: unknown } = { code, message };
    if (cause !== undefined) detail.cause = cause;
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
