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

export type { OrbitControlsLike } from "./viewer/camera-rig";
export type { TransformMode } from "./viewer/gizmo-rig";
export type { AnimationClipInfo } from "./viewer/animation-rig";

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
      onHdrError: (error, hdr) => this.#emitEnvironmentError(error, hdr.assetId),
      onSkyboxError: (error, skybox) => this.#emitEnvironmentError(error, skybox.assetId),
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
    this.#render();
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
   * Viewer framing: model-viewer's `field-of-view="auto"` is 30° in landscape
   * and 45° in portrait, applied *before* the fit so the distance follows.
   */
  frameViewer(): void {
    this.camera.fov = this.camera.aspect < 1 ? 45 : 30;
    this.camera.updateProjectionMatrix();
    this.autoFrame();
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
  ): { x: number; y: number; visible: boolean } {
    const rect = this.#canvas.getBoundingClientRect?.();
    const width = rect?.width || this.#canvas.clientWidth || 1;
    const height = rect?.height || this.#canvas.clientHeight || 1;

    const projected = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * width,
      y: (-projected.y * 0.5 + 0.5) * height,
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
    this.#render();
    return this.#canvas.toDataURL(type, quality);
  }

  /** Async sibling of {@link toDataURL}. */
  toBlob(type = "image/png", quality?: number): Promise<Blob | null> {
    this.#render();
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
    if (preset !== "room" && preset !== "neutral") return;
    this.#environment.setPreset(preset);
    // The shadow direction is derived from the studio's key light.
    this.#syncContactShadow();
    this.#render();
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
    this.#contactShadow.setLightDirection(this.#shadowLightDirection());
  }

  /**
   * Where the ground shadow falls from. A document that lights the scene itself
   * keeps its own key direction; with IBL-only lighting (the preview default) the
   * shadow follows the environment's highlight, the way model-viewer derives its
   * shadow light from the light probe.
   */
  #shadowLightDirection(): [number, number, number] {
    const directional = this.#lighting.keyLight;
    if (directional.intensity > 0) {
      const { position, target } = directional;
      const direction: [number, number, number] = [
        position.x - target.position.x,
        position.y - target.position.y,
        position.z - target.position.z,
      ];
      if (Math.hypot(...direction) > 1e-6) return direction;
    }
    return this.#environment.keyDirection();
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

  #render(): void {
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
