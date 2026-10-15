import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  PluginContext,
  PluginEditorApi,
  SceneEditorPlugin,
} from "../plugins/plugin";
import type { RuntimeContract, RuntimeEventMap, Transform } from "./runtime-contract";
import type { SceneDocument } from "../core/document/schema";

/** Editor surface the plugin host delegates through (subset of EditorController). */
export interface PluginHostEditor {
  loadDocument(doc: unknown): Promise<void>;
  getDocument(): SceneDocument;
  select(ids: string[]): void;
  clearSelection(): void;
  applyTransform(id: string, from: Transform, to: Transform): void;
  undo(): void;
  redo(): void;
  requestSave(): void;
  readonly selectedIds: readonly string[];
  readonly dirty: boolean;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface ActivePlugin {
  plugin: SceneEditorPlugin;
  uninstall: void | (() => void);
  disposers: Array<() => void>;
  offs: Array<() => void>;
}

/**
 * Reports plugin teardown failures (uninstall/disposer) so the owner can
 * surface them without the host swallowing errors silently.
 */
export type PluginErrorReporter = (code: string, message: string, cause?: unknown) => void;

/**
 * Headless plugin install/unuse — the single install(context) contract shared
 * by SceneEditorElement and the headless facade (0.2 thin-shell consolidation).
 */
export class PluginHost {
  readonly #active = new Map<string, ActivePlugin>();
  readonly #pending: SceneEditorPlugin[] = [];
  #armed = false;

  constructor(
    private readonly runtime: RuntimeContract,
    private readonly editor: PluginHostEditor,
    private readonly onError?: PluginErrorReporter,
  ) {}

  /** Queue until flushPending(); after that, installs immediately. */
  use(plugin: SceneEditorPlugin): void {
    if (this.#active.has(plugin.id) || this.#pending.some((p) => p.id === plugin.id)) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, `Duplicate plugin id: ${plugin.id}`);
    }
    if (!this.#armed) {
      this.#pending.push(plugin);
      return;
    }
    this.#install(plugin);
  }

  unuse(id: string): void {
    const idx = this.#pending.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.#pending.splice(idx, 1);
      return;
    }
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    this.#dispose(active);
  }

  /** Install queued plugins; call once after the facade is constructed. Throws on install failure. */
  flushPending(): void {
    this.#armed = true;
    const queued = this.#pending.splice(0);
    for (const plugin of queued) {
      this.#install(plugin);
    }
  }

  teardown(): void {
    for (const entry of this.#active.values()) {
      this.#dispose(entry);
    }
    this.#active.clear();
    this.#pending.length = 0;
  }

  #install(plugin: SceneEditorPlugin): void {
    const entry: ActivePlugin = { plugin, uninstall: undefined, disposers: [], offs: [] };
    const editor = this.editor;
    const editorApi: PluginEditorApi = {
      loadDocument: (doc) => editor.loadDocument(doc),
      getDocument: () => editor.getDocument(),
      select: (ids) => editor.select(ids),
      clearSelection: () => editor.clearSelection(),
      applyTransform: (id, t) => editor.applyTransform(id, t, t),
      undo: () => editor.undo(),
      redo: () => editor.redo(),
      requestSave: () => editor.requestSave(),
      get selectedIds() {
        return editor.selectedIds;
      },
      get dirty() {
        return editor.dirty;
      },
      get revision() {
        return editor.revision;
      },
      get canUndo() {
        return editor.canUndo;
      },
      get canRedo() {
        return editor.canRedo;
      },
    };
    const context: PluginContext = {
      runtime: this.runtime,
      editor: editorApi,
      on: <K extends keyof RuntimeEventMap>(
        type: K,
        handler: (payload: RuntimeEventMap[K]) => void,
      ) => {
        const off = this.runtime.events.on(type, handler);
        entry.offs.push(off);
        return off;
      },
      addDisposer: (fn) => entry.disposers.push(fn),
    };
    this.#active.set(plugin.id, entry);
    try {
      entry.uninstall = plugin.install(context);
    } catch (err) {
      this.#active.delete(plugin.id);
      throw new SceneEditorError(
        SceneErrorCode.Lifecycle,
        `Plugin install failed: ${plugin.id}`,
        { cause: err },
      );
    }
  }

  #dispose(entry: ActivePlugin): void {
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
      this.onError?.(SceneErrorCode.Lifecycle, "Plugin uninstall failed", err);
    }
    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        this.onError?.(SceneErrorCode.Lifecycle, "Plugin disposer failed", err);
      }
    }
  }
}
