import type { RuntimeContract, RuntimeEventMap, Transform } from "../runtime/runtime-contract";
import type { SceneDocument } from "../core/document/schema";

/** Narrow editor surface plugins may call (no THREE / GPU internals). */
export interface PluginEditorApi {
  loadDocument(doc: SceneDocument | unknown): Promise<void>;
  getDocument(): SceneDocument;
  select(ids: string[]): void;
  clearSelection(): void;
  applyTransform(id: string, t: Transform): void;
  undo(): void;
  redo(): void;
  requestSave(): void;
  readonly selectedIds: readonly string[];
  readonly dirty: boolean;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface PluginContext {
  /** Live runtime contract (events + methods; no THREE.Scene/Renderer). */
  readonly runtime: RuntimeContract;
  /** Editor methods delegated through the element/controller. */
  readonly editor: PluginEditorApi;
  on<K extends keyof RuntimeEventMap>(
    type: K,
    handler: (payload: RuntimeEventMap[K]) => void,
  ): () => void;
  /** Register a cleanup fn run on unuse or disconnect. */
  addDisposer(fn: () => void): void;
}

export interface SceneEditorPlugin {
  id: string;
  /** Called once when the plugin becomes active. Return optional uninstall. */
  install(context: PluginContext): void | (() => void);
}
