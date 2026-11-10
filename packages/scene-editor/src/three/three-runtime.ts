import * as THREE from "three";
import type {
  ContactShadowDTO,
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type {
  AnimationOptions,
  AutoRotateOptions,
  CameraControlsOptions,
  EnvironmentPreset,
  MorphTargetInfo,
  RuntimeContract,
  RuntimeEventMap,
  ToneMappingMode,
  Transform,
} from "../runtime/runtime-contract";
import { TypedEventBus } from "../runtime/typed-event-bus";
import { createRenderer } from "./create-renderer";
import type { RendererHandle } from "./renderer-handle";
import { createPicker, type Picker } from "./picker";
import type { AssetCache } from "../assets/asset-cache";
import { AssetErrorCode } from "../assets/asset-error";
import {
  createCameraRig,
  type CameraRig,
  type CameraView,
  type OrbitControlsLike,
} from "./viewer/camera-rig";
import { createLightingRig, type LightingRig } from "./viewer/lighting-rig";
import { createEnvironmentRig, type EnvironmentRig } from "./viewer/environment-rig";
import { createObjectStore, type ObjectStore } from "./viewer/object-store";
import { measureFraming } from "./viewer/framing";
import { createContactShadowRig, type ContactShadowRig } from "./viewer/contact-shadow";
import {
  createGizmoRig,
  type GizmoControls,
  type GizmoRig,
  type TransformMode,
} from "./viewer/gizmo-rig";
import {
  createAnimationRig,
  type AnimationClipInfo,
  type AnimationRig,
} from "./viewer/animation-rig";
import { createRenderLoop, type RenderLoop } from "./viewer/render-loop";
import { collectEmbeddedCameras, orbitTargetFor } from "./viewer/embedded-cameras";
import { createMorphRig, type MorphRig } from "./viewer/morph-rig";

export type { OrbitControlsLike } from "./viewer/camera-rig";
export type { TransformMode } from "./viewer/gizmo-rig";
export type { AnimationClipInfo } from "./viewer/animation-rig";
export type { EmbeddedCamera } from "./viewer/embedded-cameras";

/** Asset-layer codes forwarded verbatim on the runtime `error` event (D6). */
const ASSET_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(AssetErrorCode));

export interface ThreeRuntimeOptions {
  canvas: HTMLCanvasElement;
  /**
   * Injectable seam: defaults to real WebGLRenderer via createRenderer (D1).
   * Documented WebGPU opt-in: create a WebGPURenderer, `await renderer.init()`
   * BEFORE constructing the runtime (the constructor renders), then
   * `rendererFactory: () => renderer`. Detect silent fallback via
   * `renderer.backend.isWebGPUBackend === true`. This seam is the only supported
   * WebGPU path; WebGL2 remains the default.
   */
  rendererFactory?: (canvas: HTMLCanvasElement) => RendererHandle;
  /** Injectable seam: defaults to real three OrbitControls. */
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => OrbitControlsLike | null;
  /** Injectable seam: defaults to real three TransformControls. */
  transformControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => GizmoControls;
  /** Disable viewport controls (headless / unit tests). */
  enableControls?: boolean;
  /** Optional asset cache for assetId-based mesh loading (D11/D12). */
  assetCache?: AssetCache;
  /**
   * assetId → URL for **environment** assets (`view.environment.hdr` /
   * `.skybox`). Mesh assets go through `assetCache`; the environment rig only
   * needs a URL, so it takes the resolver directly.
   */
  resolveAsset?: (assetId: string) => Promise<string>;
  /** Initial gizmo mode (default `"translate"`). */
  transformMode?: TransformMode;
  /**
   * Opt-in high-frequency `view-changing` samples (default `false`). Off by
   * default because it fires on every damped frame; hosts that only need the
   * settled view use `view-change`.
   */
  liveViewEvents?: boolean;
  /**
   * Display transfer function (default `"none"` = three's raw output). The
   * preview path (`<scene-editor src>`) opts into `"aces"`.
   */
  toneMapping?: ToneMappingMode;
  /** Exposure multiplier applied on top of the tone mapping. */
  exposure?: number;
  /**
   * Built-in studio IBL (default `"room"`). The preview path opts into
   * `"neutral"`, the grayscale studio model-viewer ships as its default.
   */
  environmentPreset?: EnvironmentPreset;
}

/** Display mode → three constant. Kept here so the core stays three-free. */
const TONE_MAPPINGS: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/**
 * model-viewer's `field-of-view="auto"` framing FOV, in degrees. Constant
 * across aspects; see `frameViewer()`.
 */
const VIEWER_FRAMED_FOV = 30;
/**
 * model-viewer's default `camera-orbit` radius is `auto` → 105% of the ideal
 * distance, so its sphere leaves 5% of breathing room at the tangent point.
 */
const VIEWER_RADIUS_RATIO = 1.05;

/**
 * Production RuntimeContract implementation backed by three.js (WebGLRenderer, D1).
 *
 * Deliberately thin: each engine concern lives in a rig under `./viewer/`
 * (camera, lighting, environment, gizmo, objects, animation, render loop), the
 * same split a standalone glTF viewer uses. Scene/camera/lights/grid are engine
 * state — never persisted (D3).
 */
export class ThreeRuntime implements RuntimeContract {
  readonly events = new TypedEventBus();
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: RendererHandle;

  readonly #canvas: HTMLCanvasElement;
  readonly #cameraRig: CameraRig;
  readonly #lighting: LightingRig;
  readonly #environment: EnvironmentRig;
  readonly #objects: ObjectStore;
  readonly #contactShadow: ContactShadowRig;
  readonly #gizmo: GizmoRig;
  readonly #animation: AnimationRig;
  readonly #morph: MorphRig;
  readonly #picker: Picker;

  #renderLoop: RenderLoop | null = null;
  #selectedIds: string[] = [];
  /** Suppresses view-change while applyViewState mutates the camera (D22). */
  #applyingView = false;
  #liveViewEvents: boolean;
  #toneMapping: ToneMappingMode;
  #exposure: number | null = null;
  /** Last camera sample, so static re-renders do not fake a camera move. */
  #lastCameraSample: CameraView | null = null;
  #transformMode: TransformMode;
  /** Transport policy (autoplay / crossfade / pause-at-end); host-owned. */
  #animationOptions: AnimationOptions = {};
  /** Persisted contact-shadow settings; `undefined` = never declared (off). */
  #contactShadowView: ContactShadowDTO | undefined;
  #controlsReady: Promise<void>;
  #resolveControlsReady!: () => void;
  #animationFrame: number | null = null;
  #lastTick = 0;
  /** Off-screen / hidden-tab pause; see `setRenderingPaused`. */
  #renderingPaused = false;
  /** Cameras authored inside the loaded asset(s), in traversal order. */
  #cameras: ReturnType<typeof collectEmbeddedCameras> = [];
  /** Active embedded camera, or `null` for the document/orbit view. */
  #cameraName: string | null = null;
  /** A name set before the asset loaded; applied on the next refresh. */
  #pendingCameraName: string | null = null;
  /** Orbit view to restore when leaving an embedded camera. */
  #savedOrbitView: CameraView | null = null;

  constructor(options: ThreeRuntimeOptions) {
    this.#canvas = options.canvas;
    this.#transformMode = options.transformMode ?? "translate";
    this.#liveViewEvents = options.liveViewEvents ?? false;
    this.#toneMapping = options.toneMapping ?? "none";
    if (options.exposure !== undefined) this.#exposure = Math.max(0, options.exposure);
    this.#controlsReady = new Promise<void>((resolve) => {
      this.#resolveControlsReady = resolve;
    });

    const initial = createDefaultViewState();
    this.camera = new THREE.PerspectiveCamera(initial.camera.fov, 4 / 3, 0.1, 1000);
    const [cx, cy, cz] = initial.camera.position;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(0, 0, 0);

    this.#lighting = createLightingRig(this.scene, initial.lights);

    const factory = options.rendererFactory ?? createRenderer;
    this.renderer = factory(options.canvas);
    // Only touch the renderer when the host asked for a display mode; a
    // pre-configured rendererFactory must keep its own tone mapping.
    if (options.toneMapping !== undefined) this.#applyToneMapping();
    if (options.exposure !== undefined) this.#applyExposure();

    // After the renderer: IBL prefilters through PMREM, which needs the GPU context.
    this.#environment = createEnvironmentRig(this.scene, initial.environment, {
      renderer: this.renderer,
      preset: options.environmentPreset ?? "room",
      onEnvironmentReady: () => this.#render(),
      ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
      onHdrError: (error, source) => this.#emitEnvironmentError(error, source),
      onSkyboxError: (error, source) => this.#emitEnvironmentError(error, source),
    });

    const dom = (this.renderer as { domElement?: HTMLElement }).domElement ?? options.canvas;

    this.#cameraRig = createCameraRig({
      camera: this.camera,
      domElement: dom,
      ...(options.orbitControlsFactory ? { orbitControlsFactory: options.orbitControlsFactory } : {}),
      onRender: () => {
        this.#render();
        this.#emitViewChanging();
      },
      // A user gesture ends → the view is worth persisting (D22).
      onInteractionEnd: () => this.#emitViewChange(),
    });

    // Seed the sampler so mounting never fakes a camera move.
    this.#lastCameraSample = this.#cameraRig.readView();

    this.#renderLoop = createRenderLoop({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      getOrbit: () => this.#cameraRig.orbit,
    });

    this.#picker = createPicker({
      camera: this.camera,
      // dom is the renderer's canvas in production; the picker only needs a rect.
      canvas: dom as HTMLCanvasElement,
    });

    this.#animation = createAnimationRig();
    this.#morph = createMorphRig({
      roots: () => this.#framingRoots(),
      // A clip driving `morphTargetInfluences` owns the channel; the rig asks
      // before letting a manual weight through.
      activeTrackNames: () => this.#animation.activeTrackNames(),
    });
    this.#objects = createObjectStore({
      scene: this.scene,
      assetCache: options.assetCache ?? null,
      onAssetError: (error, dto) => this.#emitAssetError(error, dto),
      onAssetMounted: ({ objectId, object, asset }) => {
        this.#animation.register(objectId, object, asset.animations ?? []);
      },
    });

    // After the object store: the catch plane is fitted to the content bounds.
    this.#contactShadowView = initial.environment.contactShadow;
    this.#contactShadow = createContactShadowRig({
      scene: this.scene,
      renderer: this.renderer,
      contentRoots: () => this.#framingRoots(),
      // Animated content can leave its resting bounds, so the shadow volume
      // has to cover more than the box it was fitted to.
      animated: () => this.#animation.list().length > 0,
    });
    this.#syncContactShadow();

    this.#gizmo = createGizmoRig({
      scene: this.scene,
      camera: this.camera,
      domElement: dom,
      initialMode: this.#transformMode,
      getSelectedObject: () => this.#selectedObject(),
      onCommit: ({ from, to }) => {
        const id = this.#selectedIds[0];
        if (!id) return;
        this.events.emit("transform-commit", { id, from, to });
      },
      ...(options.transformControlsFactory
        ? { factory: options.transformControlsFactory }
        : {}),
    });

    if (options.enableControls !== false) {
      this.#initControls(options);
    } else {
      this.#resolveControlsReady();
    }

    this.resize();
  }

  /** Resolves when TransformControls (gizmo) is mounted, or immediately if disabled. */
  get controlsReady(): Promise<void> {
    return this.#controlsReady;
  }

  // -------------------------------------------------------------------------
  // Engine seams
  // -------------------------------------------------------------------------

  resize(width?: number, height?: number): void {
    const w = width || this.#canvas.clientWidth || this.#canvas.width || 1;
    const h = height || this.#canvas.clientHeight || this.#canvas.height || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.#render();
  }

  render(): void {
    this.#render(true);
  }

  /**
   * Stop drawing while the viewer is off-screen or the tab is hidden.
   *
   * Nothing is torn down: animation and turntable loops stop feeding frames,
   * the camera and clip time stay where they were, and the first frame after
   * resuming is rendered immediately so the canvas is never left blank.
   */
  setRenderingPaused(paused: boolean): void {
    if (paused === this.#renderingPaused) return;
    this.#renderingPaused = paused;
    this.#cameraRig.setActive(!paused);
    if (paused) {
      this.#stopAnimationLoop();
      return;
    }
    this.#render(true);
    if (this.#animation.playing) this.#ensureAnimationLoop();
  }

  // -------------------------------------------------------------------------
  // RuntimeContract
  // -------------------------------------------------------------------------

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.#stopAnimationLoop();
    this.#animation.dispose();
    // Selection is document-scoped: detach before the old objects leave the
    // graph, otherwise TransformControls keeps a stale target (and warns).
    this.#selectedIds = [];
    this.#gizmo.syncSelection(null);
    await this.#objects.load(doc, ({ totalProgress, reason }) => {
      this.events.emit("load-progress", { totalProgress, reason });
    });
    this.#picker.setTargets(this.#objects.list());
    this.#syncContactShadow();
    this.#refreshCameras();
    this.#maybeAutoplay();
    this.#render();
    this.events.emit("load", { sceneId: doc.sceneId });
  }

  applyTransform(id: string, t: Transform): void {
    if (!this.#objects.applyTransform(id, t)) return;
    // Moving content moves the shadowed footprint as well.
    this.#syncContactShadow();
    this.#render();
  }

  /**
   * Mount one object incrementally. Rejects when an asset cannot load — a single
   * object has no meaningful "partial success", unlike a whole document.
   */
  async addObject(dto: SceneObjectDTO): Promise<void> {
    await this.#objects.add(dto);
    // New objects must be pickable immediately, and the gizmo may target them.
    this.#picker.setTargets(this.#objects.list());
    this.#syncGizmo();
    this.#syncContactShadow();
    this.#refreshCameras();
    this.#maybeAutoplay();
    this.#render();
  }

  removeObject(id: string): void {
    // Detach the gizmo first: TransformControls must not keep a target that is
    // about to leave the graph.
    if (this.#selectedIds.includes(id)) {
      this.#selectedIds = this.#selectedIds.filter((selected) => selected !== id);
      this.#syncGizmo();
    }
    this.#objects.remove(id);
    this.#picker.setTargets(this.#objects.list());
    this.#syncContactShadow();
    this.#refreshCameras();
    this.#render();
  }

  reparent(id: string, parentId: string | undefined): void {
    this.#objects.reparent(id, parentId);
    this.#syncContactShadow();
    this.#render();
  }

  setMaterial(id: string, material: MaterialDTO | undefined): void {
    this.#objects.setMaterial(id, material);
    this.#render();
  }

  select(ids: string[]): void {
    this.#selectedIds = [...ids];
    this.#syncGizmo();
    this.#render();
  }

  clearSelection(): void {
    this.#selectedIds = [];
    this.#syncGizmo();
    this.#render();
  }

  pick(clientX: number, clientY: number): string | null {
    return this.#picker.pick({ clientX, clientY });
  }

  flushDisposers(): void {
    this.#stopAnimationLoop();
    this.#animation.dispose();
    this.#gizmo.dispose();
    this.#cameraRig.dispose();
    this.#contactShadow.dispose();
    this.#objects.dispose();
    this.#picker.dispose();
    this.#environment.dispose();
    this.#renderLoop?.dispose();
    this.#renderLoop = null;
    this.renderer.dispose();
  }

  getViewState(): ViewState {
    const environment = this.#environment.readView();
    return {
      camera: this.#cameraRig.readView(),
      lights: this.#lighting.readView(),
      // Omitted until a document declares it, so older views round-trip unchanged.
      environment:
        this.#contactShadowView === undefined
          ? environment
          : { ...environment, contactShadow: this.#contactShadowView },
    };
  }

  /** Apply a persisted view. Never emits view-change (that is user input only, D22). */
  applyViewState(view: ViewState): void {
    this.#applyingView = true;
    try {
      this.#cameraRig.applyView(view.camera);
      // A persisted camera pose outranks an embedded one; keeping the name
      // would make the next refresh snap the view back.
      this.#cameraName = null;
      this.#savedOrbitView = null;
      this.#lighting.applyView(view.lights);
      this.#environment.applyView(view.environment);
      this.#contactShadowView = view.environment.contactShadow;
      this.#syncContactShadow();
      this.#render();
    } finally {
      this.#applyingView = false;
      // Re-seed so the next real gesture is measured against the applied view.
      this.#lastCameraSample = this.#cameraRig.readView();
    }
  }

  /**
   * Toggle high-frequency `view-changing` sampling. Enabling seeds the sampler
   * with the current camera, so hosts get the next move rather than a duplicate
   * of a view they can already read through `getViewState()`.
   */
  setLiveViewEvents(enabled: boolean): void {
    this.#liveViewEvents = enabled;
    this.#lastCameraSample = this.#cameraRig.readView();
  }

  /** Pointer policy + orbit limits (element: `disable-pan` / `disable-zoom` / `min-max-camera-orbit`). */
  setCameraControls(options: CameraControlsOptions): void {
    this.#cameraRig.applyControls(options);
  }

  /** Turntable rotation (element: `auto-rotate` / `rotation-per-second` / `auto-rotate-delay`). */
  setAutoRotate(options: AutoRotateOptions | null): void {
    this.#cameraRig.setAutoRotate(options);
  }

  /**
   * Ease the camera to a pose (model-viewer's `interpolation-decay`). The fade
   * is presentational: `view.camera` is untouched, so a viewer attribute never
   * dirties the document or fakes a user interaction.
   */
  smoothViewTo(view: ViewState["camera"], decayMs: number): void {
    this.#cameraRig.easeTo(view, decayMs);
  }

  /**
   * `touch-action` for the canvas. Needed as a runtime call because the orbit
   * addon writes `none` onto the canvas when it connects — the viewer has to be
   * able to re-assert its value after that.
   */
  setTouchAction(value: string): void {
    this.#cameraRig.setTouchAction(value);
  }

  /** Land on the last eased goal now (model-viewer `jumpCameraToGoal()`). */
  jumpCameraToGoal(): void {
    this.#cameraRig.finishEase();
  }

  /**
   * Roll the turntable's yaw back to zero (model-viewer
   * `resetTurntableRotation()`). The camera the user dragged to is untouched.
   */
  resetTurntableRotation(theta?: number): void {
    this.#cameraRig.resetTurntableRotation(theta);
  }

  /**
   * Transport policy. Autoplay is applied to content that is already mounted,
   * so a host that sets it before `loadDocument` still gets playback.
   */
  setAnimationOptions(options: AnimationOptions): void {
    this.#animationOptions = { ...this.#animationOptions, ...options };
    this.#animation.setOptions({
      ...(options.crossfadeSeconds === undefined
        ? {}
        : { crossfadeSeconds: options.crossfadeSeconds }),
      ...(options.pauseAtEnd === undefined ? {} : { pauseAtEnd: options.pauseAtEnd }),
    });
    this.#maybeAutoplay();
  }

  /**
   * Fit the camera to the current content bounds. Used by the preview path
   * (`<scene-editor src>`) and exposed as a "reset view" action. Never touches
   * the document, so it does not mark the scene dirty.
   *
   * Framing mirrors model-viewer's default orbit (`0deg 75deg 105%`): front
   * view, 15° above the horizon. `phi = 75°` is measured from +Y, hence the 15°
   * elevation here. The fit uses the content's bounding sphere and the
   * *narrower* axis, so portrait viewports never clip.
   *
   * `padding` is calibrated against model-viewer's rendered size rather than
   * against the literal 105%: their percentage multiplies their own (tighter)
   * radius metric, and fitting our sphere at 105% left every model ~25-30%
   * smaller than the reference.
   */
  autoFrame(padding = 0.85): void {
    const box = this.#objects.bounds();
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    // Bounding-sphere radius of the content box. Measured over the whole pose, so
    // it stays put while an animation plays (a per-mesh sphere does not).
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.0001);

    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.0001));
    const fitFov = Math.max(Math.min(vFov, hFov), 0.0001);
    const distance = (radius / Math.sin(fitFov / 2)) * Math.max(padding, 0.1);

    // theta = 0°, phi = 75° from +Y → straight in front, 15° above the horizon.
    const elevation = THREE.MathUtils.degToRad(15);
    const direction = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = Math.max(distance * 100, 100);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.#cameraRig.setTarget([center.x, center.y, center.z]);
    this.#render();
  }

  /**
   * Viewer framing, ported from model-viewer's `updateFraming()` so the two
   * viewers put the same model at the same size:
   *
   * 1. `framedFov` = 30° — constant, in portrait too (v4 widens the *rendered*
   *    FOV for a narrow pane, it does not raise the framing FOV).
   * 2. `distance = radius / sin(framedFov / 2)`, where `radius` is measured to
   *    the farthest **vertex** around the target centre — not to a box corner.
   * 3. A wide model is *not* pushed back; the vertical FOV is widened instead
   *    (`idealAspect`), which is what keeps vertical fill identical across
   *    models of different proportions.
   * 4. The orbit distance is 105% of that (`camera-orbit` radius `auto`).
   *
   * Only the direction is ours: `theta = 0°, phi = 75°` → straight ahead, 15°
   * above the horizon.
   */
  frameViewer(): void {
    const centre = this.#objects.bounds();
    if (centre.isEmpty()) return;
    const center = centre.getCenter(new THREE.Vector3());
    const metrics = measureFraming(this.#framingRoots(), center);

    const halfFov = THREE.MathUtils.degToRad(VIEWER_FRAMED_FOV) / 2;
    const distance = (metrics?.radius ?? this.#sphereRadius(center)) / Math.sin(halfFov);
    const idealAspect = (metrics?.horizontalTanAt(distance) ?? 0) / Math.tan(halfFov);
    const vertical = Math.tan(halfFov) * Math.max(1, idealAspect / Math.max(this.camera.aspect, 1e-4));
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(vertical));

    const orbit = distance * VIEWER_RADIUS_RATIO;
    // theta = 0°, phi = 75° from +Y → straight in front, 15° above the horizon.
    const elevation = THREE.MathUtils.degToRad(15);
    const direction = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    this.camera.position.copy(center).addScaledVector(direction, orbit);
    this.camera.near = Math.max(orbit / 1000, 0.001);
    this.camera.far = Math.max(orbit * 100, 100);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.#cameraRig.setTarget([center.x, center.y, center.z]);
    this.#render();
  }

  // -------------------------------------------------------------------------
  // Viewer-side extras (model-viewer parity)
  // -------------------------------------------------------------------------

  /** World-space size of everything mounted; zeros when nothing is loaded. */
  dimensions(): { width: number; height: number; depth: number } {
    const bounds = this.#objects.bounds();
    if (bounds.isEmpty()) return { width: 0, height: 0, depth: 0 };
    const size = bounds.getSize(new THREE.Vector3());
    return { width: size.x, height: size.y, depth: size.z };
  }

  /**
   * Project a world point into **canvas-local CSS pixels** — what hotspot slots
   * need to stay glued to the model while the camera moves.
   */
  projectPoint(
    point: readonly [number, number, number],
  ): { x: number; y: number; z: number; visible: boolean } {
    return this.#projectToCanvas(point);
  }

  /**
   * The projection above plus model-viewer's facing test, so `data-normal` can
   * dim a hotspot once the surface it sits on turns away from the camera.
   *
   * The reference does `(camera − anchor) · normal < 0` on the **signed** dot,
   * without normalising either vector: length does not change the sign, and a
   * zero-length normal therefore counts as facing (a hotspot with no meaningful
   * normal stays visible rather than disappearing).
   */
  projectHotspot(
    point: readonly [number, number, number],
    normal: readonly [number, number, number],
  ): { x: number; y: number; z: number; visible: boolean; facingCamera: boolean } {
    const projected = this.#projectToCanvas(point);
    const dot =
      (this.camera.position.x - point[0]) * normal[0] +
      (this.camera.position.y - point[1]) * normal[1] +
      (this.camera.position.z - point[2]) * normal[2];
    return { ...projected, facingCamera: dot >= 0 };
  }

  #projectToCanvas(
    point: readonly [number, number, number],
  ): { x: number; y: number; z: number; visible: boolean } {
    const rect = this.#canvas.getBoundingClientRect?.();
    const width = rect?.width || this.#canvas.clientWidth || 1;
    const height = rect?.height || this.#canvas.clientHeight || 1;

    const projected = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * width,
      y: (-projected.y * 0.5 + 0.5) * height,
      z: projected.z,
      // Behind the camera or outside the depth range → the anchor is not visible.
      visible: projected.z >= -1 && projected.z <= 1 && projected.z < 1,
    };
  }

  /** World-space hit point + surface normal under a client coordinate. */
  positionAndNormalFromPoint(
    clientX: number,
    clientY: number,
  ): { position: [number, number, number]; normal: [number, number, number] } | null {
    const detail = this.#picker.pickDetail({ clientX, clientY });
    if (!detail) return null;
    return {
      position: [...detail.position] as [number, number, number],
      normal: [...detail.normal] as [number, number, number],
    };
  }

  /**
   * Render, then read the drawing buffer in the same task. No
   * `preserveDrawingBuffer` tax on every frame — the render happens right
   * before the read, which is exactly when the buffer still holds the frame.
   */
  toDataURL(type = "image/png", quality?: number): string {
    // A capture is a caller-driven frame: it must ignore the pause.
    this.#render(true);
    return this.#canvas.toDataURL(type, quality);
  }

  /** Async sibling of {@link toDataURL}. */
  toBlob(type = "image/png", quality?: number): Promise<Blob | null> {
    this.#render(true);
    return new Promise<Blob | null>((resolve) => {
      this.#canvas.toBlob((blob) => resolve(blob), type, quality);
    });
  }

  /**
   * Export the **document** objects (not the viewport helpers) as GLB or
   * `.gltf` JSON. Roots are passed as-is: their live transforms already mirror
   * the document, while the grid/gizmo/contact plane never lived in the store.
   */
  async exportScene(options: { binary?: boolean } = {}): Promise<ArrayBuffer | string> {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const roots = this.#objects.list();
    const exporter = new GLTFExporter();
    const result = await new Promise<unknown>((resolve, reject) => {
      exporter.parse(
        roots,
        (output) => resolve(output),
        (error) => reject(error),
        { binary: options.binary ?? true },
      );
    });
    return result instanceof ArrayBuffer ? result : JSON.stringify(result, null, 2);
  }

  /** Swap the built-in studio IBL (model-viewer `environment-image` parity). */
  setEnvironmentPreset(preset: EnvironmentPreset): void {
    if (preset !== "room" && preset !== "neutral" && preset !== "legacy") return;
    this.#environment.setPreset(preset);
    // The shadow direction is derived from the studio's key light.
    this.#syncContactShadow();
    this.#render();
  }

  /**
   * `environment-image` as a file URL: reflections only. Bypasses the asset
   * resolver — the attribute holds the path, not a document asset id.
   */
  setEnvironmentImage(url: string | null): void {
    this.#environment.setHdrUrl(url);
  }

  /**
   * `skybox-image`: the visible backdrop, and the light probe too when
   * `asEnvironment` (no explicit `environment-image`) — one download, two uses.
   */
  setSkyboxImage(url: string | null, options: { asEnvironment: boolean }): void {
    this.#environment.setSkyboxUrl(url, options.asEnvironment);
  }

  /** Display transfer function; presentation-only, never persisted. */
  setToneMapping(mode: ToneMappingMode): void {
    if (!(mode in TONE_MAPPINGS)) return;
    this.#toneMapping = mode;
    this.#applyToneMapping();
    this.#render();
  }

  /** Exposure multiplier; ignores non-finite values. */
  setExposure(value: number): void {
    if (!Number.isFinite(value)) return;
    this.#exposure = Math.max(0, value);
    this.#applyExposure();
    this.#render();
  }

  // -------------------------------------------------------------------------
  // Selection / transform tool
  // -------------------------------------------------------------------------

  get selectedIds(): readonly string[] {
    return this.#selectedIds;
  }

  get transformMode(): TransformMode {
    return this.#transformMode;
  }

  /**
   * Switch the gizmo tool. Safe before the addon finishes loading: the mode is
   * remembered and applied when TransformControls mounts.
   */
  setTransformMode(mode: TransformMode): void {
    this.#transformMode = mode;
    this.#gizmo.setMode(mode);
    this.#render();
  }

  getObjectById(id: string): THREE.Object3D | undefined {
    return this.#objects.get(id);
  }

  // -------------------------------------------------------------------------
  // Material variants (`KHR_materials_variants`, model-viewer's `variant-name`)
  // -------------------------------------------------------------------------

  /** Variant names declared by the mounted assets, in document order. */
  get variants(): string[] {
    return this.#objects.variants();
  }

  /** Currently applied variant; `null` = each asset's own materials. */
  get variantName(): string | null {
    return this.#objects.variantName;
  }

  /**
   * Switch every mounted asset to `name` (`null` restores the defaults).
   * Returns whether any mounted asset declares it — unknown names are remembered
   * anyway, so a variant set before the asset finishes loading still applies.
   */
  setVariant(name: string | null): boolean {
    return this.#objects.setVariant(name);
  }

  // -------------------------------------------------------------------------
  // Embedded cameras (glTF `node.camera`)
  // -------------------------------------------------------------------------

  /** Camera names declared by the mounted asset(s), in traversal order. */
  get cameras(): string[] {
    return this.#cameras.map((entry) => entry.name);
  }

  /** Active embedded camera; `null` = the document/orbit view. */
  get cameraName(): string | null {
    return this.#cameraName;
  }

  /**
   * Look through a camera authored inside the asset, or `null` to go back to the
   * orbit view that was active before. A name that is not loaded yet is
   * remembered and applied when the content arrives — the same contract as
   * `setVariant`.
   *
   * Only the pose and FOV are borrowed: the runtime keeps its own perspective
   * camera (and its orbit controls), so the user can still drag away from an
   * authored view instead of being locked to it.
   */
  setCameraByName(name: string | null): boolean {
    if (name === null) {
      this.#pendingCameraName = null;
      if (this.#cameraName === null) return false;
      this.#cameraName = null;
      const saved = this.#savedOrbitView;
      this.#savedOrbitView = null;
      if (saved) this.#cameraRig.applyView(saved);
      this.#render();
      return true;
    }

    const found = this.#cameras.find((entry) => entry.name === name);
    if (!found) {
      this.#pendingCameraName = name;
      return false;
    }
    this.#pendingCameraName = null;
    if (this.#cameraName === null) this.#savedOrbitView = this.#cameraRig.readView();

    found.camera.updateWorldMatrix(true, false);
    this.camera.position.copy(found.camera.getWorldPosition(new THREE.Vector3()));
    this.camera.quaternion.copy(found.camera.getWorldQuaternion(new THREE.Quaternion()));
    // An orthographic glTF camera keeps the current FOV: the runtime has no
    // ortho projection to hand its frustum to.
    const fov = (found.camera as THREE.PerspectiveCamera).fov;
    if (Number.isFinite(fov) && fov > 0) this.camera.fov = fov;
    this.camera.updateProjectionMatrix();

    const bounds = this.#objects.bounds();
    const centre = bounds.isEmpty()
      ? new THREE.Vector3()
      : bounds.getCenter(new THREE.Vector3());
    const target = orbitTargetFor(found.camera, centre);
    this.#cameraRig.setTarget([target.x, target.y, target.z]);
    this.#cameraName = name;
    this.#render();
    return true;
  }

  // -------------------------------------------------------------------------
  // Morph targets (editor surface; glTF has no viewer-level control for them)
  // -------------------------------------------------------------------------

  /** Every morph channel on the mounted content, with its current weight. */
  get morphTargets(): MorphTargetInfo[] {
    return this.#morph.list();
  }

  /**
   * Set one morph weight (clamped to 0..1). Returns `false` when the mesh,
   * target or object is gone, and when the playing clip drives that channel —
   * the mixer would overwrite the value on the next frame.
   */
  setMorphInfluence(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean {
    const applied = this.#morph.setInfluence(objectId, meshIndex, targetIndex, value);
    if (applied) this.#render();
    return applied;
  }

  // -------------------------------------------------------------------------
  // Animation (reference: clip list + transport)
  // -------------------------------------------------------------------------

  /** Clips discovered on mounted assets, in document order. */
  get animations(): AnimationClipInfo[] {
    return this.#animation.list();
  }

  get animationPlaying(): boolean {
    return this.#animation.playing;
  }

  get animationSpeed(): number {
    return this.#animation.speed;
  }

  /** Playhead of the active clip (seconds). */
  get animationTime(): number {
    return this.#animation.time;
  }

  get animationDuration(): number {
    return this.#animation.duration;
  }

  /** Play a clip; `null` objectId picks the first object that has clips. */
  playAnimation(objectId: string | null = null, index = 0): boolean {
    const started = this.#animation.play(objectId, index);
    if (started) this.#ensureAnimationLoop();
    return started;
  }

  /**
   * Play by clip name — `animation-name` / `animationName` semantics. Names are
   * matched case-insensitively across objects, first hit wins.
   */
  playAnimationByName(name: string): boolean {
    const started = this.#animation.playByName(name);
    if (started) this.#ensureAnimationLoop();
    return started;
  }

  pauseAnimations(): void {
    this.#animation.pause();
    this.#stopAnimationLoop();
    this.#render();
  }

  /** Continue a paused clip (no rewind). Returns false if nothing is loaded. */
  resumeAnimations(): boolean {
    const resumed = this.#animation.resume();
    if (resumed) this.#ensureAnimationLoop();
    return resumed;
  }

  setAnimationSpeed(speed: number): void {
    this.#animation.setSpeed(speed);
    if (this.#animation.playing) this.#ensureAnimationLoop();
  }

  /** Scrub the active clip (seconds). */
  setAnimationTime(seconds: number): void {
    this.#animation.setTime(seconds);
    this.#render();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #initControls(options: ThreeRuntimeOptions): void {
    const dom = (this.renderer as { domElement?: HTMLElement }).domElement ?? this.#canvas;

    try {
      if (options.orbitControlsFactory) {
        this.#cameraRig.mount(options.orbitControlsFactory(this.camera, dom));
      } else {
        // Lazy import keeps unit tests (no WebGL) free of examples/jsm side effects.
        void this.#cameraRig.mountDefault();
      }
    } catch {
      // optional addon unavailable — a controls-less runtime still works
    }

    if (options.transformControlsFactory) {
      this.#gizmo.mount(options.transformControlsFactory(this.camera, dom));
      this.#syncGizmo();
      this.#render();
      this.#resolveControlsReady();
    } else {
      void this.#gizmo.mountDefault().then(() => {
        this.#syncGizmo();
        this.#render();
        this.#resolveControlsReady();
      });
    }
  }

  #selectedObject(): THREE.Object3D | null {
    const id = this.#selectedIds[0];
    return id ? (this.#objects.get(id) ?? null) : null;
  }

  #syncGizmo(): void {
    this.#gizmo.syncSelection(this.#selectedObject());
  }

  /** Re-fit the catch plane to the current content (mount / transform / view). */
  #syncContactShadow(): void {
    this.#contactShadow.applyView(this.#contactShadowView, this.#objects.bounds());
  }

  /** Re-scan the content for authored cameras; settle a name set before load. */
  #refreshCameras(): void {
    this.#cameras = collectEmbeddedCameras(this.#framingRoots());
    const names = new Set(this.#cameras.map((entry) => entry.name));
    if (this.#pendingCameraName !== null && names.has(this.#pendingCameraName)) {
      this.setCameraByName(this.#pendingCameraName);
      return;
    }
    // The asset that carried the active camera is gone: fall back to the orbit
    // view rather than leaving the camera pointed through empty space.
    if (this.#cameraName !== null && !names.has(this.#cameraName)) {
      this.setCameraByName(null);
    }
  }

  /**
   * Content roots for vertex measurement — the document's mounted objects only,
   * never the rig's own scene furniture (shadow catcher, environment panels).
   */
  #framingRoots(): THREE.Object3D[] {
    return this.#objects.list().filter((object) => object.parent === this.scene);
  }

  /** Box-corner radius: only a fallback for content without readable vertices. */
  #sphereRadius(center: THREE.Vector3): number {
    const box = this.#objects.bounds();
    if (box.isEmpty()) return 1;
    return Math.max(box.max.distanceTo(center), box.min.distanceTo(center), 0.0001);
  }

  #emitViewChange(): void {
    if (this.#applyingView) return;
    this.events.emit("view-change", { view: this.getViewState() });
  }

  /**
   * Sample the camera at render time; cheap enough for every damped frame.
   * `camera-change` is always reported (auto-rotate has no gesture to hang an
   * event on); the full `view-changing` payload stays opt-in.
   */
  #emitViewChanging(): void {
    if (this.#applyingView) return;
    const camera = this.#cameraRig.readView();
    const previous = this.#lastCameraSample;
    if (previous !== null && sameCameraView(previous, camera)) return;
    this.#lastCameraSample = camera;
    this.events.emit("camera-change", camera);
    if (this.#liveViewEvents) this.events.emit("view-changing", { view: this.getViewState() });
  }

  /** Start playback when the host asked for it and content brought clips along. */
  #maybeAutoplay(): void {
    if (this.#animationOptions.autoplay !== true) return;
    const name = this.#animationOptions.clipName;
    const started =
      typeof name === "string" && name.length > 0
        ? this.#animation.playByName(name)
        : this.#animation.play(null, 0);
    if (started) this.#ensureAnimationLoop();
  }

  #emitAssetError(err: unknown, dto: { id: string; assetId?: string | undefined }): void {
    // Forward the loader's classification (resolve / load / format / not-found)
    // instead of collapsing everything into a generic load failure.
    const candidate = (err as { code?: string }).code;
    const code = candidate && ASSET_ERROR_CODES.has(candidate) ? candidate : "asset-load-failed";
    this.events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { objectId: dto.id, assetId: dto.assetId },
    } as RuntimeEventMap["error"]);
  }

  /** A broken HDR / skybox keeps the previous look but must not be silent. */
  #emitEnvironmentError(err: unknown, assetId: string): void {
    const candidate = (err as { code?: string }).code;
    const code = candidate && ASSET_ERROR_CODES.has(candidate) ? candidate : "asset-load-failed";
    this.events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { assetId, kind: "environment" },
    } as RuntimeEventMap["error"]);
  }

  /** Stubs without GPU display settings silently skip this. */
  #applyToneMapping(): void {
    if (this.renderer.toneMapping !== undefined) {
      this.renderer.toneMapping = TONE_MAPPINGS[this.#toneMapping];
    }
  }

  /** Split from tone mapping so `setExposure` never overwrites the transfer. */
  #applyExposure(): void {
    if (this.renderer.toneMappingExposure !== undefined && this.#exposure !== null) {
      this.renderer.toneMappingExposure = this.#exposure;
    }
  }

  #render(force = false): void {
    // Off-screen viewers (IntersectionObserver / hidden tab) keep their state
    // but must not draw; a capture or a resume passes `force`.
    if (this.#renderingPaused && !force) return;
    // The shadow is a texture, not a shadow map: it has to be re-rendered when
    // the content moves, and it must happen outside the main scene render.
    this.#contactShadow.update();
    this.#renderLoop?.render();
  }

  #ensureAnimationLoop(): void {
    if (this.#animationFrame !== null) return;
    if (typeof requestAnimationFrame !== "function") return;

    const raf = requestAnimationFrame;
    this.#lastTick = typeof performance !== "undefined" ? performance.now() : Date.now();

    const tick = (now: number): void => {
      this.#animationFrame = null;
      const delta = Math.max(0, now - this.#lastTick) / 1000;
      this.#lastTick = now;
      // Clamp: a backgrounded tab must not jump the clip forward by seconds.
      const playing = this.#animation.update(Math.min(delta, 0.1));
      if (playing) this.#contactShadow.invalidate();
      this.#render();
      if (playing) this.#animationFrame = raf(tick);
    };

    this.#animationFrame = raf(tick);
  }

  #stopAnimationLoop(): void {
    if (this.#animationFrame === null) return;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#animationFrame);
    }
    this.#animationFrame = null;
  }
}

/**
 * Camera-only equality for live sampling: lights/environment renders must not
 * be reported as camera movement.
 */
function sameCameraView(a: CameraView, b: CameraView): boolean {
  if (a.fov !== b.fov) return false;
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.target[0] === b.target[0] &&
    a.target[1] === b.target[1] &&
    a.target[2] === b.target[2]
  );
}
