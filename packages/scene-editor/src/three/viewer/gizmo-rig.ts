import type * as THREE from "three";
import {
  createTransformControlsBinding,
  type TransformControlsBinding,
  type TransformControlsLike,
  type TransformSnapshot,
} from "../transform-controls-binding";

/** Gizmo mode exposed by the three runtime (translate is the default tool). */
export type TransformMode = "translate" | "rotate" | "scale";

/** Minimal TransformControls surface, including the 0.18x helper split. */
export type GizmoControls = TransformControlsLike & {
  update?: () => void;
  getHelper?: () => THREE.Object3D;
  dispose?: () => void;
};

export interface GizmoRigOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  initialMode: TransformMode;
  getSelectedObject: () => THREE.Object3D | null;
  /** One completed drag → one command (D15). */
  onCommit: (payload: { from: TransformSnapshot; to: TransformSnapshot }) => void;
  /** Injectable seam: defaults to three's TransformControls, lazily imported. */
  factory?: (camera: THREE.Camera, domElement: HTMLElement) => GizmoControls | null;
}

export interface GizmoRig {
  /** Resolves when the addon mounted, or immediately if it is unavailable. */
  readonly ready: Promise<void>;
  readonly controls: GizmoControls | null;
  readonly mode: TransformMode;
  mount(controls: GizmoControls | null | undefined): void;
  /** Lazily import three's TransformControls. Never rejects. */
  mountDefault(): Promise<void>;
  setMode(mode: TransformMode): void;
  /** Re-attach (or detach) the gizmo after a selection change. */
  syncSelection(object: THREE.Object3D | null): void;
  dispose(): void;
}

/**
 * TransformControls lifecycle + drag→command binding (reference: `addGUI`
 * camera/object controls). Mounting is lazy so unit tests never pay for
 * examples/jsm side effects.
 */
export function createGizmoRig(options: GizmoRigOptions): GizmoRig {
  let controls: GizmoControls | null = null;
  let binding: TransformControlsBinding | null = null;
  let mode = options.initialMode;
  let resolved = false;

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const settle = (): void => {
    if (resolved) return;
    resolved = true;
    resolveReady();
  };

  const removeHelper = (target: GizmoControls): void => {
    const helper = target.getHelper?.() ?? (target as unknown as THREE.Object3D);
    if ((helper as THREE.Object3D | undefined)?.isObject3D) {
      options.scene.remove(helper as THREE.Object3D);
    }
  };

  const rig: GizmoRig = {
    get ready(): Promise<void> {
      return ready;
    },
    get controls(): GizmoControls | null {
      return controls;
    },
    get mode(): TransformMode {
      return mode;
    },
    mount(next: GizmoControls | null | undefined): void {
      if (!next) {
        settle();
        return;
      }
      try {
        controls = next;
        next.setMode?.(mode);
        const helper = next.getHelper?.() ?? (next as unknown as THREE.Object3D);
        if ((helper as THREE.Object3D | undefined)?.isObject3D) {
          const object3d = helper as THREE.Object3D;
          if (!options.scene.getObjectById(object3d.id)) options.scene.add(object3d);
        }
        binding = createTransformControlsBinding({
          controls: next,
          getSelectedObject: options.getSelectedObject,
          onTransform: options.onCommit,
        });
      } catch {
        // A broken/incompatible addon must not take the runtime down.
        controls = null;
        binding = null;
      } finally {
        settle();
      }
    },
    async mountDefault(): Promise<void> {
      try {
        const { TransformControls } = await import(
          "three/examples/jsm/controls/TransformControls.js"
        );
        rig.mount(
          new TransformControls(
            options.camera,
            options.domElement,
          ) as unknown as GizmoControls,
        );
      } catch {
        settle();
      }
    },
    setMode(next: TransformMode): void {
      mode = next;
      controls?.setMode?.(next);
    },
    syncSelection(object: THREE.Object3D | null): void {
      if (!binding) return;
      if (object) {
        binding.attach(object);
        binding.updateSelectedObject(object);
      } else {
        binding.detach();
      }
    },
    dispose(): void {
      binding?.dispose();
      binding = null;
      if (controls) {
        removeHelper(controls);
        controls.detach?.();
        controls.dispose?.();
        controls = null;
      }
      settle();
    },
  };

  return rig;
}
