import * as THREE from "three";
import type { SceneDocument, ViewState } from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type { RuntimeContract, RuntimeEventMap, Transform } from "../runtime/runtime-contract";
import { TypedEventBus } from "../runtime/typed-event-bus";
import { createRenderer } from "./create-renderer";
import type { RendererHandle } from "./renderer-handle";
import { createPicker, type Picker } from "./picker";
import type { AssetCache } from "../assets/asset-cache";
import { createCameraRig, type CameraRig, type OrbitControlsLike } from "./viewer/camera-rig";
import { createLightingRig, type LightingRig } from "./viewer/lighting-rig";
import { createEnvironmentRig, type EnvironmentRig } from "./viewer/environment-rig";
import { createObjectStore, type ObjectStore } from "./viewer/object-store";
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
  /** Initial gizmo mode (default `"translate"`). */
  transformMode?: TransformMode;
}

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
  readonly #gizmo: GizmoRig;
  readonly #animation: AnimationRig;
  readonly #picker: Picker;

  #renderLoop: RenderLoop | null = null;
  #selectedIds: string[] = [];
  /** Suppresses view-change while applyViewState mutates the camera (D22). */
  #applyingView = false;
  #transformMode: TransformMode;
  #controlsReady: Promise<void>;
  #resolveControlsReady!: () => void;
  #animationFrame: number | null = null;
  #lastTick = 0;

  constructor(options: ThreeRuntimeOptions) {
    this.#canvas = options.canvas;
    this.#transformMode = options.transformMode ?? "translate";
    this.#controlsReady = new Promise<void>((resolve) => {
      this.#resolveControlsReady = resolve;
    });

    const initial = createDefaultViewState();
    this.camera = new THREE.PerspectiveCamera(initial.camera.fov, 4 / 3, 0.1, 1000);
    const [cx, cy, cz] = initial.camera.position;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(0, 0, 0);

    this.#lighting = createLightingRig(this.scene, initial.lights);
    this.#environment = createEnvironmentRig(this.scene, initial.environment);

    const factory = options.rendererFactory ?? createRenderer;
    this.renderer = factory(options.canvas);

    const dom = (this.renderer as { domElement?: HTMLElement }).domElement ?? options.canvas;

    this.#cameraRig = createCameraRig({
      camera: this.camera,
      domElement: dom,
      ...(options.orbitControlsFactory ? { orbitControlsFactory: options.orbitControlsFactory } : {}),
      onRender: () => this.#render(),
      // A user gesture ends → the view is worth persisting (D22).
      onInteractionEnd: () => this.#emitViewChange(),
    });

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
    await this.#objects.load(doc);
    this.#picker.setTargets(this.#objects.list());
    this.#render();
  }

  applyTransform(id: string, t: Transform): void {
    if (this.#objects.applyTransform(id, t)) this.#render();
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
    this.#objects.dispose();
    this.#picker.dispose();
    this.#renderLoop?.dispose();
    this.#renderLoop = null;
    this.renderer.dispose();
  }

  getViewState(): ViewState {
    return {
      camera: this.#cameraRig.readView(),
      lights: this.#lighting.readView(),
      environment: this.#environment.readView(),
    };
  }

  /** Apply a persisted view. Never emits view-change (that is user input only, D22). */
  applyViewState(view: ViewState): void {
    this.#applyingView = true;
    try {
      this.#cameraRig.applyView(view.camera);
      this.#lighting.applyView(view.lights);
      this.#environment.applyView(view.environment);
      this.#render();
    } finally {
      this.#applyingView = false;
    }
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

  #emitViewChange(): void {
    if (this.#applyingView) return;
    this.events.emit("view-change", { view: this.getViewState() });
  }

  #emitAssetError(err: unknown, dto: { id: string; assetId?: string | undefined }): void {
    const code =
      (err as { code?: string }).code === "asset-resolve-failed"
        ? "asset-resolve-failed"
        : "asset-load-failed";
    this.events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { objectId: dto.id, assetId: dto.assetId },
    } as RuntimeEventMap["error"]);
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
