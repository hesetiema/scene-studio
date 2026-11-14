import * as THREE from "three";
import type { ContactShadowDTO, SceneObjectDTO } from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type {
  EnvironmentPreset,
  RuntimeEventBus,
  RuntimeEventMap,
  ToneMappingMode,
} from "../runtime/runtime-contract";
import { AssetErrorCode } from "../assets/asset-error";
import type { AssetCache } from "../assets/asset-cache";
import { createRenderer } from "./create-renderer";
import type { RendererHandle } from "./renderer-handle";
import { createPicker, type Picker } from "./picker";
import { TONE_MAPPINGS } from "./tone-mapping";
import {
  createCameraRig,
  type CameraRig,
  type OrbitControlsLike,
} from "./viewer/camera-rig";
import { createLightingRig, type LightingRig } from "./viewer/lighting-rig";
import { createEnvironmentRig, type EnvironmentRig } from "./viewer/environment-rig";
import { createObjectStore, type ObjectStore } from "./viewer/object-store";
import { createInstancingRig, type InstancingRig } from "./viewer/instancing-rig";
import {
  createSharedResourcePool,
  type SharedResourcePool,
} from "./viewer/shared-resources";
import { createContactShadowRig, type ContactShadowRig } from "./viewer/contact-shadow";
import {
  createGizmoRig,
  type GizmoControls,
  type GizmoRig,
  type TransformMode,
} from "./viewer/gizmo-rig";
import { createAnimationRig, type AnimationRig } from "./viewer/animation-rig";
import { createRenderLoop, type RenderLoop } from "./viewer/render-loop";
import { createMorphRig, type MorphRig } from "./viewer/morph-rig";
import { createDisplayRig, type DisplayRig } from "./viewer/display-rig";
import { createExplodeRig, type ExplodeRig } from "./viewer/explode-rig";

/** Asset-layer codes forwarded verbatim on the runtime `error` event (D6). */
const ASSET_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(AssetErrorCode));

/**
 * Callbacks the assembly needs from the runtime it is building.
 *
 * They all read runtime state that does not exist until `createRigSet` returns
 * (the render loop, the contact shadow, the selected id). That is safe because
 * none of them fires during construction — the same invariant the inline
 * constructor relied on when its closures captured `this.#…` fields that were
 * assigned further down.
 */
export interface AssemblyHooks {
  /** Draw one frame. Tolerates rigs the assembly has not created yet. */
  render: (force?: boolean) => void;
  /** The camera moved on a damped frame; sample it and report. */
  emitViewChanging: () => void;
  /** A user gesture ended — the view is worth persisting (D22). */
  emitViewChange: () => void;
  /** Mounted document objects only, never the runtime's own furniture. */
  framingRoots: () => THREE.Object3D[];
  /** Objects of the last loaded document — the explode baseline reads these. */
  documentObjects: () => readonly SceneObjectDTO[];
  selectedObject: () => THREE.Object3D | null;
  selectedId: () => string | undefined;
}

/**
 * The construction seams the assembly reads.
 *
 * A structural subset of `ThreeRuntimeOptions`, which `ThreeRuntime` passes
 * whole. Declared here instead of imported from the runtime so this module
 * never points back at it — that would close an import cycle (B3).
 */
export interface AssemblyOptions {
  canvas: HTMLCanvasElement;
  rendererFactory?: (canvas: HTMLCanvasElement) => RendererHandle;
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => OrbitControlsLike | null;
  transformControlsFactory?: (camera: THREE.Camera, domElement: HTMLElement) => GizmoControls;
  assetCache?: AssetCache;
  instancing?: boolean;
  resources?: SharedResourcePool;
  resolveAsset?: (assetId: string) => Promise<string>;
  transformMode?: TransformMode;
  toneMapping?: ToneMappingMode;
  exposure?: number;
  environmentPreset?: EnvironmentPreset;
}

export interface AssemblyContext {
  scene: THREE.Scene;
  /** The runtime's own options; the assembly reads the seams it wires. */
  options: AssemblyOptions;
  events: RuntimeEventBus;
  hooks: AssemblyHooks;
}

/**
 * Every engine rig, in creation order. The runtime keeps them as fields and the
 * assembly hands them over as one bundle, so the constructor stays a list of
 * assignments instead of a 170-line wiring block.
 */
export interface RigSet {
  camera: THREE.PerspectiveCamera;
  renderer: RendererHandle;
  lighting: LightingRig;
  environment: EnvironmentRig;
  cameraRig: CameraRig;
  renderLoop: RenderLoop;
  picker: Picker;
  animation: AnimationRig;
  morph: MorphRig;
  /** `null` when the host turned batching off (`instancing: false`). */
  batcher: InstancingRig | null;
  resources: SharedResourcePool;
  /** Only a pool this assembly created is disposed on teardown. */
  ownsResources: boolean;
  objects: ObjectStore;
  display: DisplayRig;
  explode: ExplodeRig;
  contactShadow: ContactShadowRig;
  /** Persisted contact-shadow settings; `undefined` = never declared (off). */
  contactShadowView: ContactShadowDTO | undefined;
  gizmo: GizmoRig;
}

/**
 * Create and wire the whole engine layer for `ThreeRuntime`.
 *
 * The runtime owns state and the contract surface; this module owns the
 * *creation order*. That order is load-bearing and only reviewable when it is
 * written down in one place:
 *
 *   lighting → renderer → environment (IBL prefilters through PMREM, so the GL
 *   context must exist) → camera rig → render loop → picker → animation →
 *   morph → batcher + resources → object store (the store indexes what those
 *   two own) → display / explode / contact shadow (all three walk the store) →
 *   gizmo (it attaches to whatever the store resolves as selected).
 *
 * Anything whose callback needs an earlier rig closes over the local binding,
 * never over a field: `morph` reads `animation.activeTrackNames()` that way.
 */
export function createRigSet(context: AssemblyContext): RigSet {
  const { scene, options, events, hooks } = context;
  const canvas = options.canvas;
  const initial = createDefaultViewState();

  const camera = new THREE.PerspectiveCamera(initial.camera.fov, 4 / 3, 0.1, 1000);
  const [cx, cy, cz] = initial.camera.position;
  camera.position.set(cx, cy, cz);
  camera.lookAt(0, 0, 0);

  const lighting = createLightingRig(scene, initial.lights);

  const rendererFactory = options.rendererFactory ?? createRenderer;
  const renderer = rendererFactory(canvas);
  // Only touch the renderer when the host asked for a display mode; a
  // pre-configured rendererFactory must keep its own tone mapping.
  if (options.toneMapping !== undefined && renderer.toneMapping !== undefined) {
    renderer.toneMapping = TONE_MAPPINGS[options.toneMapping];
  }
  if (options.exposure !== undefined && renderer.toneMappingExposure !== undefined) {
    renderer.toneMappingExposure = Math.max(0, options.exposure);
  }

  /** Forward the loader's classification instead of collapsing every failure. */
  const emitAssetError = (
    err: unknown,
    dto: { id: string; assetId?: string | undefined },
  ): void => {
    const candidate = (err as { code?: string }).code;
    const code = candidate && ASSET_ERROR_CODES.has(candidate) ? candidate : "asset-load-failed";
    events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { objectId: dto.id, assetId: dto.assetId },
    } as RuntimeEventMap["error"]);
  };

  /** A broken HDR / skybox keeps the previous look but must not be silent. */
  const emitEnvironmentError = (err: unknown, assetId: string): void => {
    const candidate = (err as { code?: string }).code;
    const code = candidate && ASSET_ERROR_CODES.has(candidate) ? candidate : "asset-load-failed";
    events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { assetId, kind: "environment" },
    } as RuntimeEventMap["error"]);
  };

  // After the renderer: IBL prefilters through PMREM, which needs the GPU context.
  const environment = createEnvironmentRig(scene, initial.environment, {
    renderer,
    preset: options.environmentPreset ?? "room",
    onEnvironmentReady: () => hooks.render(),
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
    onHdrError: (error, source) => emitEnvironmentError(error, source),
    onSkyboxError: (error, source) => emitEnvironmentError(error, source),
  });

  const dom = (renderer as { domElement?: HTMLElement }).domElement ?? canvas;

  const cameraRig = createCameraRig({
    camera,
    domElement: dom,
    ...(options.orbitControlsFactory ? { orbitControlsFactory: options.orbitControlsFactory } : {}),
    onRender: () => {
      hooks.render();
      hooks.emitViewChanging();
    },
    // A user gesture ends → the view is worth persisting (D22).
    onInteractionEnd: () => hooks.emitViewChange(),
  });

  const renderLoop = createRenderLoop({
    renderer,
    scene,
    camera,
    getOrbit: () => cameraRig.orbit,
  });

  const picker = createPicker({
    camera,
    // dom is the renderer's canvas in production; the picker only needs a rect.
    canvas: dom as HTMLCanvasElement,
  });

  const animation = createAnimationRig({
    // Transport transitions are host-facing events (`play` / `pause` / `loop` /
    // `finished`); the rig knows when they happen, the bus carries them.
    onTransport: (event) => {
      switch (event.type) {
        case "play":
          events.emit("play", {
            objectId: event.objectId,
            index: event.index,
            name: event.name,
          });
          break;
        case "pause":
          events.emit("pause", null);
          break;
        case "loop":
          events.emit("loop", { count: event.count, name: event.name });
          break;
        case "finished":
          events.emit("finished", { objectId: event.objectId, name: event.name });
          break;
      }
    },
  });

  const morph = createMorphRig({
    roots: () => hooks.framingRoots(),
    // A clip driving `morphTargetInfluences` owns the channel; the rig asks
    // before letting a manual weight through.
    activeTrackNames: () => animation.activeTrackNames(),
  });

  const batcher = options.instancing === false ? null : createInstancingRig({ scene });
  const resources = options.resources ?? createSharedResourcePool();
  const ownsResources = options.resources === undefined;
  const objects = createObjectStore({
    scene,
    assetCache: options.assetCache ?? null,
    batcher,
    resources,
    onAssetError: (error, dto) => emitAssetError(error, dto),
    onAssetMounted: ({ objectId, object, asset }) => {
      animation.register(objectId, object, asset.animations ?? []);
    },
  });

  // After the object store: both rigs walk it, and the explode baseline reads
  // document positions (never the live, possibly-offset ones).
  const display = createDisplayRig({
    store: objects,
    batchRoot: () => batcher?.root() ?? null,
    onInvalidate: () => hooks.render(),
  });
  const explode = createExplodeRig({
    store: objects,
    getObjects: () => hooks.documentObjects(),
    onInvalidate: () => hooks.render(),
  });

  // After the object store: the catch plane is fitted to the content bounds.
  const contactShadowView = initial.environment.contactShadow;
  const contactShadow = createContactShadowRig({
    scene,
    renderer,
    // Batched instances are hidden proxies, so the depth pass needs the
    // `InstancedMesh` root alongside them or nothing is captured.
    contentRoots: () => {
      const roots = hooks.framingRoots();
      const batchRoot = batcher?.root();
      if (batchRoot) roots.push(batchRoot);
      return roots;
    },
    // Animated content can leave its resting bounds, so the shadow volume has
    // to cover more than the box it was fitted to.
    animated: () => animation.list().length > 0,
  });
  contactShadow.applyView(contactShadowView, objects.bounds());

  const gizmo = createGizmoRig({
    scene,
    camera,
    domElement: dom,
    initialMode: options.transformMode ?? "translate",
    getSelectedObject: () => hooks.selectedObject(),
    onCommit: ({ from, to }) => {
      const id = hooks.selectedId();
      if (!id) return;
      events.emit("transform-commit", { id, from, to });
    },
    ...(options.transformControlsFactory ? { factory: options.transformControlsFactory } : {}),
  });

  return {
    camera,
    renderer,
    lighting,
    environment,
    cameraRig,
    renderLoop,
    picker,
    animation,
    morph,
    batcher,
    resources,
    ownsResources,
    objects,
    display,
    explode,
    contactShadow,
    contactShadowView,
    gizmo,
  };
}
