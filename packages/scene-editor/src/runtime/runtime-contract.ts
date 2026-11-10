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
export type EnvironmentPreset = "room" | "neutral" | "legacy";

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
  /**
   * Inertia after a gesture, as OrbitControls' `dampingFactor` (0..1; `0.08`
   * is the addon's own default). Omitted = no damping, i.e. the camera stops
   * the instant the pointer does.
   */
  damping?: number;
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

/**
 * One glTF clip discovered on a mounted asset — model-viewer's
 * `availableAnimations`, except that it keeps the owner: a document may hold
 * several animated objects and each gets its own mixer.
 */
export interface AnimationClipInfo {
  /** Stable runtime id: `${objectId}#${index}`. */
  id: string;
  objectId: string;
  index: number;
  name: string;
  duration: number;
}

/**
 * One morph-target channel exposed to a host (`morphTargetInfluences[i]`).
 * Meshes are addressed by `(objectId, meshIndex)`: traversal order survives a
 * reload, mesh uuids do not.
 */
export interface MorphTargetInfo {
  /** Document object that owns the mesh. */
  objectId: string;
  /** Index among the object's morph-capable meshes, in traversal order. */
  meshIndex: number;
  meshName: string;
  /** Index within `morphTargetInfluences`. */
  targetIndex: number;
  /** glTF morph target name, or `Target n` when the asset omits it. */
  name: string;
  /** Current weight (glTF never declares influences outside 0..1). */
  influence: number;
  /**
   * `true` while the playing clip writes this channel — manual weights are
   * overwritten on the next frame, so `setMorphInfluence` refuses.
   */
  driven: boolean;
}

export type RuntimeEventMap = {  "selection-change": { ids: string[] };
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
  /**
   * Ease the camera to a pose instead of snapping (model-viewer interpolates
   * `camera-orbit` / `camera-target` writes; `decayMs` is `interpolation-decay`).
   * Purely presentational: this never writes `view.camera`.
   */
  smoothViewTo?(view: ViewState["camera"], decayMs: number): void;
  /** Land on the last eased goal immediately (model-viewer `jumpCameraToGoal()`). */
  jumpCameraToGoal?(): void;
  /**
   * `touch-action` on the canvas. The orbit addon hard-codes `none` when it
   * connects, so this must be re-assertable after mount, not just DOM styling.
   */
  setTouchAction?(value: string): void;
  /**
   * Undo the turntable's accumulated yaw (model-viewer
   * `resetTurntableRotation()`): the model faces front again without disturbing
   * the orbit the user dragged to. No-op when the turntable never ran.
   */
  resetTurntableRotation?(theta?: number): void;
  /** Playback transport options (autoplay / crossfade / pause-at-end). */
  setAnimationOptions?(options: AnimationOptions): void;

  // --- Playback transport (optional) ----------------------------------------
  // model-viewer's animation surface (`availableAnimations` / `animationName` /
  // `paused` / `play()` / `pause()` / `currentTime` / `timeScale`). Runtimes
  // without an animation rig omit the whole block; the element then reports an
  // empty clip list instead of pretending to play something.

  /** Clips on the mounted content, in document order. */
  readonly animations?: AnimationClipInfo[];
  /** `true` while a clip is advancing the mixers. */
  readonly animationPlaying?: boolean;
  /** Playhead of the active clip, seconds. */
  readonly animationTime?: number;
  /** Duration of the active clip, seconds (`0` = nothing active). */
  readonly animationDuration?: number;
  /** Playback rate multiplier (`timeScale`). */
  readonly animationSpeed?: number;
  /**
   * Start a clip from its first frame. `objectId: null` picks the first object
   * that has clips, `index` defaults to the first clip.
   */
  playAnimation?(objectId?: string | null, index?: number): boolean;
  /** Start a clip by name (case-insensitive); `false` when no clip matches. */
  playAnimationByName?(name: string): boolean;
  /** Hold the playhead where it is; rendering continues. */
  pauseAnimations?(): void;
  /** Continue the paused clip without rewinding; `false` when nothing is loaded. */
  resumeAnimations?(): boolean;
  /** Scrub the active clip (seconds, clamped to its duration). */
  setAnimationTime?(seconds: number): void;
  /** Playback rate multiplier; `0` freezes the mixer. */
  setAnimationSpeed?(speed: number): void;
  /** Fit the camera to the current content bounds (preview / "reset view"). */
  autoFrame?(): void;
  /**
   * Stop/resume drawing without losing state (off-screen element, hidden tab).
   * Implementations should keep the camera, clip time and loops intact and draw
   * one frame immediately on resume.
   */
  setRenderingPaused?(paused: boolean): void;
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
  /**
   * `environment-image` naming a file: reflections from that HDR/EXR/panorama,
   * backdrop untouched. `null` hands the IBL back to the preset (or to the
   * document's own HDR). Last call wins; a broken file keeps the studio.
   */
  setEnvironmentImage?(url: string | null): void;
  /**
   * `skybox-image`: the visible backdrop. `asEnvironment` mirrors model-viewer —
   * a skybox with no explicit `environment-image` also lights the model, from
   * the same download. `null` removes it.
   */
  setSkyboxImage?(url: string | null, options: { asEnvironment: boolean }): void;
  /**
   * Variant names declared by the loaded asset(s) — `KHR_materials_variants`,
   * model-viewer's `availableVariants`. Empty when the asset declares none.
   */
  readonly variants?: string[];
  /** Currently applied variant; `null` = the asset's own materials. */
  readonly variantName?: string | null;
  /**
   * Switch to a declared variant; `null` restores the defaults. Warmup calls
   * before the asset loads are remembered, not dropped.
   */
  setVariant?(name: string | null): boolean;
  /**
   * Camera names authored inside the loaded asset(s) — glTF `node.camera`.
   * Empty when the asset declares none.
   */
  readonly cameras?: string[];
  /** Active embedded camera; `null` = the document/orbit view. */
  readonly cameraName?: string | null;
  /**
   * Look through an authored camera (`null` restores the previous orbit view).
   * Names set before the asset loads are remembered, not dropped.
   */
  setCameraByName?(name: string | null): boolean;
  /** Morph channels on the mounted content, with weights and animation state. */
  readonly morphTargets?: MorphTargetInfo[];
  /**
   * Set one morph weight. Returns `false` when the channel is gone or a playing
   * clip drives it — an animated value would snap back on the next frame.
   */
  setMorphInfluence?(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean;

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
