import type { SceneDocument, ViewState } from "../core/document/schema";

export interface Transform {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
}

/**
 * Display transfer function. Presentation-only (never persisted in the scene
 * document): `none` keeps the raw linear output, `aces` is the filmic default
 * used by the preview path.
 */
export type ToneMappingMode = "none" | "linear" | "aces" | "agx" | "neutral";

export type RuntimeEventMap = {
  "selection-change": { ids: string[] };
  "history-change": {
    canUndo: boolean;
    canRedo: boolean;
    dirty: boolean;
    lastCommand?: string;
  };
  /** One completed TransformControls drag (D15) — one command. */
  "transform-commit": {
    id: string;
    from: Transform;
    to: Transform;
  };
  /** Interaction-driven viewport change (never emitted by applyViewState, D22). */
  "view-change": { view: ViewState };
  /**
   * High-frequency camera sample while a view change is in flight (D22).
   * Opt-in via `setLiveViewEvents(true)`; never emitted by `applyViewState`,
   * and only when the camera actually moved (light/environment renders are not
   * sampled). Runtimes that do not support it simply never emit.
   */
  "view-changing": { view: ViewState };
  /**
   * Aggregate progress for the load in flight (0..1). Coarse by design: byte
   * progress is spread across the document's meshes, so it stays monotonic.
   */
  "load-progress": { totalProgress: number; reason: string };
  /** The current document finished loading; the runtime is renderable. */
  load: { sceneId: string };
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
  /** Current camera/lights/environment as a persistable snapshot (D22). */
  getViewState(): ViewState;
  /** Apply a persisted view without raising view-change (D22). */
  applyViewState(view: ViewState): void;
  /**
   * Toggle high-frequency `view-changing` sampling (default off).
   * Optional: runtimes without live sampling omit it and hosts fall back to
   * `view-change` only.
   */
  setLiveViewEvents?(enabled: boolean): void;
  /** Fit the camera to the current content bounds (preview / "reset view"). */
  autoFrame?(): void;
  /** Display transfer function; presentation-only, never persisted. */
  setToneMapping?(mode: ToneMappingMode): void;
  /** Exposure multiplier applied on top of the tone mapping. */
  setExposure?(value: number): void;
  readonly events: RuntimeEventBus;
}
