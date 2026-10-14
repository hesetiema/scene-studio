import type { SceneDocument } from "../core/document/schema";

export interface Transform {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
}

export type RuntimeEventMap = {
  "selection-change": { ids: string[] };
  "history-change": {
    canUndo: boolean;
    canRedo: boolean;
    dirty: boolean;
    lastCommand?: string;
  };
  error: { code: string; message: string; cause?: unknown };
};

export interface RuntimeEventBus {
  on<K extends keyof RuntimeEventMap>(
    type: K,
    handler: (payload: RuntimeEventMap[K]) => void,
  ): () => void;
  emit<K extends keyof RuntimeEventMap>(type: K, payload: RuntimeEventMap[K]): void;
}

/** The only seam between Core/Element and any concrete runtime (D5). */
export interface RuntimeContract {
  loadDocument(doc: SceneDocument): Promise<void>;
  applyTransform(id: string, t: Transform): void;
  clearSelection(): void;
  select(ids: string[]): void;
  pick(clientX: number, clientY: number): string | null;
  flushDisposers(): void;
  readonly events: RuntimeEventBus;
}
