import * as THREE from "three";
import type { ViewState } from "../../core/document/schema";

/** Minimal OrbitControls surface the runtime needs (real or injected, D22). */
export interface OrbitControlsLike {
  update?: () => void;
  dispose: () => void;
  target?: THREE.Vector3;
  addEventListener?: (type: string, handler: () => void) => void;
}

export type CameraView = ViewState["camera"];

export interface CameraRigOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  /** Injectable seam: defaults to three's OrbitControls, lazily imported. */
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => OrbitControlsLike | null;
  onRender: () => void;
  /** Fired once per user gesture end — the only source of `view-change` (D22). */
  onInteractionEnd: () => void;
}

export interface CameraRig {
  readonly orbit: OrbitControlsLike | null;
  /** Orbit target, or the remembered fallback when controls are absent. */
  readonly target: THREE.Vector3;
  /** Attach an already-created OrbitControls (injected or lazily imported). */
  mount(orbit: OrbitControlsLike | null): void;
  /** Lazily import three's OrbitControls and mount it. Never rejects. */
  mountDefault(): Promise<void>;
  readView(): CameraView;
  applyView(view: CameraView): void;
  /** Keep the target in sync when no controls exist (headless / disabled, D22). */
  setTarget(target: readonly [number, number, number]): void;
  dispose(): void;
}

/**
 * Camera + OrbitControls ownership (reference: `defaultCamera` / `controls`).
 *
 * The addon may mount *after* a document applied its `view`; without re-seeding
 * the target it would re-derive the camera around (0,0,0) and throw away the
 * restored framing (showed up as flaky first-frame camera in the visual gate).
 */
export function createCameraRig(options: CameraRigOptions): CameraRig {
  const { camera } = options;
  const fallbackTarget = new THREE.Vector3(0, 0, 0);
  let orbit: OrbitControlsLike | null = null;

  const rig: CameraRig = {
    get orbit(): OrbitControlsLike | null {
      return orbit;
    },
    get target(): THREE.Vector3 {
      return orbit?.target ?? fallbackTarget;
    },
    mount(next: OrbitControlsLike | null): void {
      orbit = next;
      if (!next) return;
      next.target?.set(fallbackTarget.x, fallbackTarget.y, fallbackTarget.z);
      next.addEventListener?.("change", options.onRender);
      next.addEventListener?.("end", options.onInteractionEnd);
      options.onRender();
    },
    async mountDefault(): Promise<void> {
      try {
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        rig.mount(
          new OrbitControls(camera, options.domElement) as unknown as OrbitControlsLike,
        );
      } catch {
        // optional addon unavailable — a controls-less runtime still works
      }
    },
    readView(): CameraView {
      const target = rig.target;
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [target.x, target.y, target.z],
        fov: camera.fov,
      };
    },
    applyView(view: CameraView): void {
      const [x, y, z] = view.position;
      const [tx, ty, tz] = view.target;
      camera.position.set(x, y, z);
      camera.fov = view.fov;
      camera.lookAt(tx, ty, tz);
      camera.updateProjectionMatrix();
      rig.setTarget(view.target);
    },
    setTarget(target: readonly [number, number, number]): void {
      const [x, y, z] = target;
      fallbackTarget.set(x, y, z);
      orbit?.target?.set(x, y, z);
    },
    dispose(): void {
      orbit?.dispose();
      orbit = null;
    },
  };

  return rig;
}
