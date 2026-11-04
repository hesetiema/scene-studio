import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  RuntimeContract,
  ToneMappingMode,
  Transform,
} from "../runtime/runtime-contract";
import type { SceneDocument, ViewState } from "../core/document/schema";
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
   * Observed knobs: `live-view-events` (opt-in sampling), `src` (declarative
   * preview source), `tone-mapping` / `exposure` (display only, never saved).
   */
  static get observedAttributes(): string[] {
    return ["live-view-events", "src", "tone-mapping", "exposure"];
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
  /** Who owns the document: declarative `src` or an explicit `loadDocument()`. */
  #documentOwner: "host" | "src" | null = null;
  #ready!: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (err: unknown) => void;
  #abort: AbortController | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #wasDisconnected = false;
  readonly #pendingPlugins: SceneEditorPlugin[] = [];

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
    if (name === "src" && this.#editor) {
      // Changing `src` is an explicit switch back to preview mode: the host
      // asked for this model, so it wins over a previously loaded document.
      this.#applyDisplaySettings();
      void this.#loadSrc();
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
    this.#pendingPlugins.length = 0;
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
    performance.mark("scene-editor:load:start");
    try {
      await this.#requireEditor().loadDocument(doc);
    } finally {
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
    this.#documentOwner = "src";
    try {
      await editor.loadDocument(createSrcDocument(src));
      // Preview framing: the document's default view is only a fallback.
      editor.runtime.autoFrame?.();
    } catch {
      // The facade already emitted `error`; swallowing keeps the
      // fire-and-forget call site free of unhandled rejections.
    }
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
      const runtime = SceneEditorElement.runtimeFactory(
        canvas,
        assetResolver ? { assetResolver } : {},
      );
      const editor = createSceneEditor({ runtime });
      this.#editor = editor;
      // Attributes set before upgrade land here: observedAttributes fires during
      // upgrade, but the runtime only exists now.
      runtime.setLiveViewEvents?.(this.#liveViewEvents);
      this.#applyDisplaySettings();

      // Click-to-select (P2-T7): pick on canvas click, empty → clear.
      // Shift / Ctrl / Cmd makes the click additive (toggle), matching the
      // facade's multi-select surface (`add` / `remove` / `toggle`).
      const onClick = (event: MouseEvent): void => {
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

      // One TransformControls drag → one undoable command (D15 / P2-T6).
      runtime.events.on("transform-commit", ({ id, from, to }) => {
        editor.applyTransform(id, from, to);
      });

      // resize seam: ThreeRuntime exposes resize(); FakeRuntime does not (optional).
      const maybeResize = runtime as { resize?: (w?: number, h?: number) => void };
      const applySize = (): void => {
        maybeResize?.resize?.(this.clientWidth, this.clientHeight);
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
      editor.on("progress", (payload) => {
        this.dispatchEvent(new CustomEvent("progress", { detail: payload }));
      });
      editor.on("load", (payload) => {
        // Only the `src` path knows a URL; headless/host documents report null.
        const url = this.#documentOwner === "src" ? this.src : null;
        this.dispatchEvent(new CustomEvent("load", { detail: { ...payload, url } }));
      });
      editor.on("error", (payload) => {
        this.dispatchEvent(new CustomEvent("error", { detail: payload }));
      });

      this.addEventListener("keydown", this.#onKeyDown, { signal });

      this.dispatchEvent(new CustomEvent("scene-ready"));
      this.#resolveReady();

      // Declarative preview loads after `ready`, so a host that awaits the
      // element still observes `progress` / `load`.
      if (this.src && this.#documentOwner !== "host") void this.#loadSrc();

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
