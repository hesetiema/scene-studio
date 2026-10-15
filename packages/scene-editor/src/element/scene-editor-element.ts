import { EditorController } from "../runtime/editor-controller";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type { RuntimeContract, Transform } from "../runtime/runtime-contract";
import type { SceneDocument } from "../core/document/schema";
import { ThreeRuntime } from "../three/three-runtime";
import type { PluginContext, PluginEditorApi, SceneEditorPlugin } from "../plugins/plugin";
import type { AssetResolver } from "../assets/resolver-asset-loader";
import { createResolverAssetLoader } from "../assets/resolver-asset-loader";
import { AssetCache } from "../assets/asset-cache";
import type { MinimalGltfLoader } from "../assets/gltf-asset-loader";

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

interface ActivePlugin {
  plugin: SceneEditorPlugin;
  uninstall: void | (() => void);
  disposers: Array<() => void>;
  offs: Array<() => void>;
}

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

  #controller: EditorController | null = null;
  #ready!: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (err: unknown) => void;
  #abort: AbortController | null = null;
  #lastDirty = false;
  #wasDisconnected = false;
  readonly #activePlugins = new Map<string, ActivePlugin>();
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
    if (this.#controller) return;
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
    const controller = this.#controller;
    this.#controller = null;
    this.#teardownAllPlugins();
    try {
      controller?.destroy();
    } catch (err) {
      this.#emitError(SceneErrorCode.Lifecycle, "Controller destroy failed", err);
    }
  }

  /**
   * Install a plugin (design §5: `install(context)` form).
   * Queued if called before init; duplicate id throws.
   */
  use(plugin: SceneEditorPlugin): void {
    if (this.#activePlugins.has(plugin.id) || this.#pendingPlugins.some((p) => p.id === plugin.id)) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, `Duplicate plugin id: ${plugin.id}`);
    }
    if (!this.#controller) {
      this.#pendingPlugins.push(plugin);
      return;
    }
    this.#installPlugin(plugin);
  }

  /** Uninstall a plugin by id; runs its uninstall + disposers. */
  unuse(id: string): void {
    const idx = this.#pendingPlugins.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.#pendingPlugins.splice(idx, 1);
      return;
    }
    const active = this.#activePlugins.get(id);
    if (!active) return;
    this.#activePlugins.delete(id);
    this.#disposePlugin(active);
  }

  #installPlugin(plugin: SceneEditorPlugin): void {
    const controller = this.#controller;
    if (!controller) return;
    const runtime = controller.runtime;
    const entry: ActivePlugin = { plugin, uninstall: undefined, disposers: [], offs: [] };
    const editorApi: PluginEditorApi = {
      loadDocument: (doc) => controller.loadDocument(doc),
      getDocument: () => controller.getDocument(),
      select: (ids) => controller.select(ids),
      clearSelection: () => controller.clearSelection(),
      applyTransform: (id, t) => controller.applyTransform(id, t, t),
      undo: () => {
        controller.undo();
      },
      redo: () => {
        controller.redo();
      },
      requestSave: () => this.requestSave(),
      get selectedIds() {
        return controller.selectedIds;
      },
      get dirty() {
        return controller.dirty;
      },
      get revision() {
        return controller.revision;
      },
      get canUndo() {
        return controller.canUndo;
      },
      get canRedo() {
        return controller.canRedo;
      },
    };
    const context: PluginContext = {
      runtime,
      editor: editorApi,
      on: (type, handler) => {
        const off = runtime.events.on(type, handler);
        entry.offs.push(off);
        return off;
      },
      addDisposer: (fn) => entry.disposers.push(fn),
    };
    this.#activePlugins.set(plugin.id, entry);
    try {
      entry.uninstall = plugin.install(context);
    } catch (err) {
      this.#activePlugins.delete(plugin.id);
      throw new SceneEditorError(
        SceneErrorCode.Lifecycle,
        `Plugin install failed: ${plugin.id}`,
        { cause: err },
      );
    }
  }

  #disposePlugin(entry: ActivePlugin): void {
    for (const off of entry.offs.splice(0)) {
      try {
        off();
      } catch {
        // listener off must not block teardown
      }
    }
    try {
      entry.uninstall?.();
    } catch (err) {
      this.#emitError(SceneErrorCode.Lifecycle, "Plugin uninstall failed", err);
    }
    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        this.#emitError(SceneErrorCode.Lifecycle, "Plugin disposer failed", err);
      }
    }
  }

  #teardownAllPlugins(): void {
    for (const entry of this.#activePlugins.values()) {
      this.#disposePlugin(entry);
    }
    this.#activePlugins.clear();
    this.#pendingPlugins.length = 0;
  }

  async loadDocument(doc: unknown): Promise<void> {
    performance.mark("scene-editor:load:start");
    try {
      await this.#requireController().loadDocument(doc);
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
    return this.#requireController().getDocument();
  }

  get revision(): number {
    return this.#requireController().revision;
  }

  get dirty(): boolean {
    return this.#requireController().dirty;
  }

  get selectedIds(): readonly string[] {
    return this.#requireController().selectedIds;
  }

  /**
   * Resolves when the runtime finished mounting viewport controls (gizmo).
   * FakeRuntime and other non-three runtimes resolve immediately.
   */
  get controlsReady(): Promise<void> {
    const runtime = this.#requireController().runtime as {
      controlsReady?: Promise<void>;
    };
    return runtime.controlsReady ?? Promise.resolve();
  }

  /** Host confirmed save: adopt server revision and clear dirty (D17/D18). */
  markSaved(serverRevision: number): void {
    this.#requireController().markSaved(serverRevision);
  }

  selectObject(id: string): void {
    this.#requireController().select([id]);
  }

  executeCommand(command: Parameters<EditorController["executeCommand"]>[0]): void {
    this.#requireController().executeCommand(command);
  }

  applyTransform(id: string, from: Transform, to: Transform): void {
    this.#requireController().applyTransform(id, from, to);
  }

  undo(): void {
    this.#requireController().undo();
  }

  redo(): void {
    this.#requireController().redo();
  }

  /** Authoritative save path (D18): hosts persist in response to this event. */
  requestSave(): void {
    const doc = this.getDocument();
    this.dispatchEvent(
      new CustomEvent("save-request", {
        detail: { reason: "manual", document: doc, revision: doc.revision },
      }),
    );
  }

  #requireController(): EditorController {
    if (!this.#controller) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor not initialized");
    }
    return this.#controller;
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
      const controller = new EditorController(runtime);
      this.#controller = controller;

      // Click-to-select (P2-T7): pick on canvas click, empty → clear.
      const onClick = (event: MouseEvent): void => {
        const picked = runtime.pick(event.clientX, event.clientY);
        if (picked) controller.select([picked]);
        else controller.clearSelection();
      };
      canvas.addEventListener("click", onClick, { signal });

      // One TransformControls drag → one undoable command (D15 / P2-T6).
      runtime.events.on("transform-commit", ({ id, from, to }) => {
        controller.applyTransform(id, from, to);
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
        controller.disposers.add(() => ro.disconnect());
      }

      runtime.events.on(
        "selection-change",
        (payload) => {
          this.dispatchEvent(new CustomEvent("selection-change", { detail: payload }));
        },
        // signal support not on bus — manual off on disconnect via destroy of runtime
      );

      runtime.events.on("history-change", (payload) => {
        this.dispatchEvent(new CustomEvent("history-change", { detail: payload }));
        if (payload.dirty !== this.#lastDirty) {
          this.#lastDirty = payload.dirty;
          this.dispatchEvent(
            new CustomEvent("document-dirty", { detail: { dirty: payload.dirty } }),
          );
        }
      });

      this.addEventListener("keydown", this.#onKeyDown, { signal });

      this.dispatchEvent(new CustomEvent("scene-ready"));
      this.#resolveReady();

      // flush plugins queued before init (use() before connect)
      const queued = this.#pendingPlugins.splice(0);
      for (const plugin of queued) {
        try {
          this.#installPlugin(plugin);
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
    const ke = event as KeyboardEvent;
    const controller = this.#controller;
    if (!controller) return;
    // Focus domain (D20): ignore keys unless focus is inside this element.
    const active = document.activeElement;
    if (active !== this && !this.contains(active)) return;
    const mod = ke.ctrlKey || ke.metaKey;
    const key = ke.key.toLowerCase();
    if (mod && key === "z" && !ke.shiftKey) {
      ke.preventDefault();
      controller.undo();
      return;
    }
    if ((mod && key === "z" && ke.shiftKey) || (mod && key === "y")) {
      ke.preventDefault();
      controller.redo();
      return;
    }
    // G/R/S tool modes: reserved for stage 2; swallowed so hosts can rely on capture list.
    if (!mod && (key === "g" || key === "r" || key === "s")) {
      ke.preventDefault();
    }
  };

  #emitError(code: string, message: string, cause?: unknown): void {
    const detail: { code: string; message: string; cause?: unknown } = { code, message };
    if (cause !== undefined) detail.cause = cause;
    this.dispatchEvent(new CustomEvent("error", { detail }));
  }
}
