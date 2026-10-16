import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type { RuntimeContract, Transform } from "../runtime/runtime-contract";
import type { SceneDocument } from "../core/document/schema";
import { ThreeRuntime } from "../three/three-runtime";
import type { SceneEditorPlugin } from "../plugins/plugin";
import type { AssetResolver } from "../assets/resolver-asset-loader";
import { createResolverAssetLoader } from "../assets/resolver-asset-loader";
import { AssetCache } from "../assets/asset-cache";
import type { MinimalGltfLoader } from "../assets/gltf-asset-loader";
import type { Command } from "../core/history/command-history";
import { createSceneEditor, type SceneEditor } from "../runtime/create-scene-editor";

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

  /** Host-provided asset resolution — set before connect/ready. */
  assetResolver: AssetResolver | null = null;

  #editor: SceneEditor | null = null;
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

  selectObject(id: string): void {
    this.#requireEditor().select([id]);
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

  /** Authoritative save path (D18): hosts persist in response to this event. */
  requestSave(): void {
    this.#requireEditor().requestSave();
  }

  #requireEditor(): SceneEditor {
    if (!this.#editor) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor not initialized");
    }
    return this.#editor;
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
      const runtime = SceneEditorElement.runtimeFactory(
        canvas,
        this.assetResolver ? { assetResolver: this.assetResolver } : {},
      );
      const editor = createSceneEditor({ runtime });
      this.#editor = editor;

      // Click-to-select (P2-T7): pick on canvas click, empty → clear.
      const onClick = (event: MouseEvent): void => {
        const picked = runtime.pick(event.clientX, event.clientY);
        if (picked) editor.select([picked]);
        else editor.clearSelection();
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
      editor.on("error", (payload) => {
        this.dispatchEvent(new CustomEvent("error", { detail: payload }));
      });

      this.addEventListener("keydown", this.#onKeyDown, { signal });

      this.dispatchEvent(new CustomEvent("scene-ready"));
      this.#resolveReady();

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
}
