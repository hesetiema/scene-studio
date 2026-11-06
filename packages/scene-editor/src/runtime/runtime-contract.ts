import type {
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";

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

/**
 * Built-in studio IBL used when the view does not name an HDR:
 * `room` = three's warm `RoomEnvironment` (editor default),
 * `neutral` = grayscale softbox studio matching model-viewer's `neutral`.
 */
export type EnvironmentPreset = "room" | "neutral";

/**
 * Orbit limits in model-viewer terms (`min-camera-orbit` / `max-camera-orbit`):
 * `theta` = azimuth, `phi` = polar angle from +Y, both in **degrees**; `radius`
 * is the orbit distance in world units. A missing axis stays unlimited.
 */
export interface CameraOrbitLimits {
  theta?: readonly [number, number];
  phi?: readonly [number, number];
  radius?: readonly [number, number];
}

/** Pointer-verb switches, mirroring model-viewer's `disable-pan` / `disable-zoom`. */
export interface CameraControlsOptions {
  pan?: boolean;
  zoom?: boolean;
  limits?: CameraOrbitLimits;
}

/** model-viewer `auto-rotate` + `rotation-per-second` + `auto-rotate-delay`. */
export interface AutoRotateOptions {
  enabled: boolean;
  /** Degrees per second (`rotation-per-second`, default 30). */
  degreesPerSecond?: number;
  /** Idle time after a gesture before rotation resumes (`auto-rotate-delay`, ms). */
  delayMs?: number;
}

/**
 * Playback knobs a viewer host owns (never part of the document): the same
 * names model-viewer exposes as `autoplay` / `animation-name` /
 * `animation-crossfade-duration` / `pause-at-end`.
 */
export interface AnimationOptions {
  /** Play the first (or `clipName`) clip as soon as content mounts. */
  autoplay?: boolean;
  /** Clip to autoplay by name; `null`/missing = first clip. */
  clipName?: string | null;
  /** Crossfade between clips, in seconds (`0` = hard cut). */
  crossfadeSeconds?: number;
  /** One-shot playback that stops on the last frame instead of looping. */
  pauseAtEnd?: boolean;
}

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
   * Camera pose sample, emitted whenever the camera actually moved — including
   * auto-rotate, which has no gesture. Cheap (six numbers, once per rendered
   * frame); the full {@link ViewState} sample stays opt-in on `view-changing`.
   * Never emitted while `applyViewState` runs (that is not user motion).
   */
  "camera-change": ViewState["camera"];
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
  /**
   * Pointer/limit policy for the orbit controls (model-viewer `disable-pan`,
   * `disable-zoom`, `min/max-camera-orbit`). Optional: runtimes without user
   * controls ignore it.
   */
  setCameraControls?(options: CameraControlsOptions): void;
  /** Auto-rotation; `null` stops it. Optional for the same reason as above. */
  setAutoRotate?(options: AutoRotateOptions | null): void;
  /** Playback transport options (autoplay / crossfade / pause-at-end). */
  setAnimationOptions?(options: AnimationOptions): void;
  /** Fit the camera to the current content bounds (preview / "reset view"). */
  autoFrame?(): void;
  /**
   * Viewer framing, model-viewer style: `field-of-view="auto"` (30° landscape,
   * 45° portrait) plus `camera-orbit="auto auto auto"` (front, 15° elevation,
   * 105% of the ideal fit). Editors keep `autoFrame()` — it respects the
   * document's own FOV.
   */
  frameViewer?(): void;
  /** World-space size of the mounted content (`0` per axis when empty). */
  dimensions?(): { width: number; height: number; depth: number };
  /**
   * Canvas-local CSS-pixel projection of a world point; `visible: false` when it
   * is behind the camera. Drives `slot="hotspot-*"` anchors.
   */
  projectPoint?(
    point: readonly [number, number, number],
  ): { x: number; y: number; visible: boolean };
  /** World-space hit point + surface normal under a client coordinate. */
  positionAndNormalFromPoint?(
    clientX: number,
    clientY: number,
  ): { position: [number, number, number]; normal: [number, number, number] } | null;
  /** Render, then capture the canvas as a data URL. */
  toDataURL?(type?: string, quality?: number): string;
  /** Render, then capture the canvas as a Blob. */
  toBlob?(type?: string, quality?: number): Promise<Blob | null>;
  /** Export the document objects as GLB (`binary` default) or `.gltf` JSON. */
  exportScene?(options?: { binary?: boolean }): Promise<ArrayBuffer | string>;
  /** Display transfer function; presentation-only, never persisted. */
  setToneMapping?(mode: ToneMappingMode): void;
  /** Exposure multiplier applied on top of the tone mapping. */
  setExposure?(value: number): void;
  /**
   * Swap the built-in studio IBL (model-viewer's `environment-image` parity).
   * Inert while the view supplies its own HDR; environments without a
   * procedural probe simply ignore it.
   */
  setEnvironmentPreset?(preset: EnvironmentPreset): void;

  // --- Incremental editing (optional) ---------------------------------------
  // Whole-document runtimes omit these; the commands that need them raise a
  // `lifecycle` error instead of silently editing the document without a scene.

  /**
   * Mount one object. Asset-backed objects resolve once mounted; a failure
   * rejects and the facade surfaces it on the `error` event.
   */
  addObject?(dto: SceneObjectDTO): void | Promise<void>;
  /** Unmount one object. Cascade ordering stays with the caller. */
  removeObject?(id: string): void;
  /** Re-attach an object under another parent (`undefined` = scene root). */
  reparent?(id: string, parentId: string | undefined): void;
  /** Replace or clear one object's material override. */
  setMaterial?(id: string, material: MaterialDTO | undefined): void;

  readonly events: RuntimeEventBus;
}
