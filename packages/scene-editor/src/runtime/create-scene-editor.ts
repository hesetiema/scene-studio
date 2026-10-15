import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type { SceneDocument } from "../core/document/schema";
import { EditorController } from "./editor-controller";
import type { Command } from "../core/history/command-history";
import { PluginHost, type PluginHostEditor } from "./plugin-host";
import { handleEditorKeyCommand, type KeyboardLike } from "./keyboard";
import type { RuntimeContract, Transform } from "./runtime-contract";
import type { SceneEditorPlugin } from "../plugins/plugin";

/** Facade event map — element event names carried over one-for-one (no DOM). */
export type SceneEditorEventMap = {
  "selection-change": { ids: string[] };
  "history-change": {
    canUndo: boolean;
    canRedo: boolean;
    dirty: boolean;
    lastCommand?: string;
  };
  /** Dirty crossed false↔true (mirrors the element's document-dirty event). */
  "document-dirty": { dirty: boolean };
  /** Host should persist `document` now; confirm with markSaved(serverRevision). */
  "save-request": {
    reason: "manual";
    document: SceneDocument;
    revision: number;
  };
  error: { code: string; message: string; cause?: unknown };
};

export interface CreateSceneEditorOptions {
  /**
   * Required. Test with FakeRuntime, production with ThreeRuntime, or any
   * RuntimeContract implementation — the facade never imports three.
   */
  runtime: RuntimeContract;
}

/** Headless editor facade: state + commands + typed events + plugins, zero DOM. */
export interface SceneEditor {
  readonly runtime: RuntimeContract;

  loadDocument(doc: unknown): Promise<void>;
  getDocument(): SceneDocument;
  markSaved(serverRevision: number): void;
  /** Inbound remote update; throws structured conflict unless fast-forward-able (D17). */
  applyRemote(
    input: unknown,
    options: { baseRevision: number },
  ): Promise<void>;

  select(ids: string[]): void;
  add(ids: string[]): void;
  remove(ids: string[]): void;
  toggle(id: string): void;
  clearSelection(): void;

  applyTransform(id: string, from: Transform, to: Transform): void;
  /** First-class entry for host-defined undoable actions (compare: PC history.add). */
  executeCommand(command: Command): void;
  undo(): boolean;
  redo(): boolean;

  requestSave(): void;

  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  readonly revision: number;
  readonly selectedIds: readonly string[];

  on<K extends keyof SceneEditorEventMap>(
    type: K,
    handler: (payload: SceneEditorEventMap[K]) => void,
  ): () => void;

  use(plugin: SceneEditorPlugin): void;
  unuse(id: string): void;

  /** Host forwards key events here; returns true when the facade consumed it. */
  handleKeyDown(event: KeyboardLike): boolean;

  destroy(): void;
}

class SceneEditorFacade implements SceneEditor, PluginHostEditor {
  readonly runtime: RuntimeContract;
  readonly #controller: EditorController;
  readonly #plugins: PluginHost;
  readonly #handlers = new Map<
    keyof SceneEditorEventMap,
    Set<(payload: never) => void>
  >();
  #lastDirty = false;
  #destroyed = false;

  constructor(options: CreateSceneEditorOptions) {
    this.runtime = options.runtime;
    this.#controller = new EditorController(options.runtime);
    this.#plugins = new PluginHost(options.runtime, this, (code, message, cause) => {
      this.#emit("error", { code, message, cause });
    });

    this.runtime.events.on("selection-change", (payload) => {
      this.#emit("selection-change", { ids: [...payload.ids] });
    });
    this.runtime.events.on("history-change", (payload) => {
      this.#emit("history-change", payload);
      if (payload.dirty !== this.#lastDirty) {
        this.#lastDirty = payload.dirty;
        this.#emit("document-dirty", { dirty: payload.dirty });
      }
    });
    this.#plugins.flushPending();
  }

  async loadDocument(doc: unknown): Promise<void> {
    this.#assertLive();
    try {
      await this.#controller.loadDocument(doc);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
  }

  getDocument(): SceneDocument {
    this.#assertLive();
    return this.#controller.getDocument();
  }

  markSaved(serverRevision: number): void {
    this.#assertLive();
    this.#controller.markSaved(serverRevision);
  }

  applyRemote(input: unknown, options: { baseRevision: number }): Promise<void> {
    this.#assertLive();
    try {
      return this.#controller.applyRemote(input, options);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
  }

  select(ids: string[]): void {
    this.#assertLive();
    this.#controller.select(ids);
  }

  add(ids: string[]): void {
    this.#assertLive();
    this.#controller.select([...new Set([...this.#controller.selectedIds, ...ids])]);
  }

  remove(ids: string[]): void {
    this.#assertLive();
    const drop = new Set(ids);
    this.#controller.select(this.#controller.selectedIds.filter((id) => !drop.has(id)));
  }

  toggle(id: string): void {
    if (this.#controller.selection.isSelected(id)) this.remove([id]);
    else this.add([id]);
  }

  clearSelection(): void {
    this.#assertLive();
    this.#controller.clearSelection();
  }

  applyTransform(id: string, from: Transform, to: Transform): void {
    this.#assertLive();
    this.#controller.applyTransform(id, from, to);
  }

  executeCommand(command: Command): void {
    this.#assertLive();
    this.#controller.executeCommand(command);
  }

  undo(): boolean {
    this.#assertLive();
    return this.#controller.undo();
  }

  redo(): boolean {
    this.#assertLive();
    return this.#controller.redo();
  }

  requestSave(): void {
    this.#assertLive();
    const document = this.#controller.getDocument();
    this.#emit("save-request", {
      reason: "manual",
      document,
      revision: document.revision,
    });
  }

  get canUndo(): boolean {
    return this.#controller.canUndo;
  }

  get canRedo(): boolean {
    return this.#controller.canRedo;
  }

  get dirty(): boolean {
    return this.#controller.dirty;
  }

  get revision(): number {
    return this.#controller.revision;
  }

  get selectedIds(): readonly string[] {
    return this.#controller.selectedIds;
  }

  on<K extends keyof SceneEditorEventMap>(
    type: K,
    handler: (payload: SceneEditorEventMap[K]) => void,
  ): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  use(plugin: SceneEditorPlugin): void {
    this.#assertLive();
    this.#plugins.use(plugin);
  }

  unuse(id: string): void {
    this.#plugins.unuse(id);
  }

  handleKeyDown(event: KeyboardLike): boolean {
    this.#assertLive();
    return handleEditorKeyCommand(this.#controller, event);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#plugins.teardown();
    this.#controller.destroy();
    // Full teardown: controller flushes its stack; the runtime contract's
    // flushDisposers releases GPU/scene resources (host-owned lifetime, D5).
    try {
      this.runtime.flushDisposers();
    } catch (err) {
      this.#emitError(err);
    }
    this.#handlers.clear();
  }

  #assertLive(): void {
    if (this.#destroyed) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor destroyed");
    }
  }

  #emit<K extends keyof SceneEditorEventMap>(
    type: K,
    payload: SceneEditorEventMap[K],
  ): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      (handler as (p: SceneEditorEventMap[K]) => void)(payload);
    }
  }

  #emitError(err: unknown): void {
    if (err instanceof SceneEditorError) {
      this.#emit("error", { code: err.code, message: err.message, cause: err.cause });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      this.#emit("error", { code: SceneErrorCode.Lifecycle, message, cause: err });
    }
  }
}

/**
 * Create a headless editor: no DOM, no canvas, no CustomEvent.
 * The host owns UI and input wiring; this owns state, history, selection,
 * plugins, and typed events.
 *
 * ```ts
 * const editor = createSceneEditor({ runtime: new FakeRuntime() });
 * await editor.loadDocument(doc);
 * editor.on("save-request", ({ document }) => persist(document));
 * ```
 */
export function createSceneEditor(options: CreateSceneEditorOptions): SceneEditor {
  return new SceneEditorFacade(options);
}
