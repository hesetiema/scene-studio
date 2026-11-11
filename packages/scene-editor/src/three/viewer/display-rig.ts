import * as THREE from "three";
import type { DisplayModeId } from "../../runtime/runtime-contract";
import type { ObjectStore } from "./object-store";

type OverrideMode = Exclude<DisplayModeId, "studio">;

/**
 * One shared override material per mode application. The mesh count does not
 * multiply materials: nothing ever mutates an override, so sharing is safe.
 */
const OVERRIDE_MATERIALS: Record<OverrideMode, () => THREE.Material> = {
  xray: () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x0a2233,
      transmission: 0.9,
      opacity: 0.75,
      transparent: true,
      roughness: 0.12,
      metalness: 0.15,
      ior: 1.45,
      emissive: 0x05425c,
      emissiveIntensity: 0.5,
    }),
  wireframe: () =>
    new THREE.MeshStandardMaterial({
      color: 0x38e2ff,
      wireframe: true,
      roughness: 0.5,
    }),
  normal: () => new THREE.MeshNormalMaterial(),
  clay: () =>
    new THREE.MeshStandardMaterial({
      color: 0xd0d4dc,
      roughness: 0.65,
      metalness: 0.05,
    }),
};

export interface DisplayRig {
  setMode(mode: DisplayModeId): void;
  /** Currently applied mode; `"studio"` when never set. */
  readonly mode: DisplayModeId;
  /**
   * Re-apply the current mode to freshly mounted content (`load` / `add` /
   * `setInstancing`). No-op in `"studio"`.
   */
  refresh(): void;
  /** Restore every original material and drop the overrides. */
  dispose(): void;
}

export interface DisplayRigOptions {
  /** Document objects: exactly the meshes a mode may repaint. */
  store: ObjectStore;
  /**
   * Root of the instancing rig's `InstancedMesh` chunks, when batching is on.
   * The chunks share the batch material, so a mode has to swap them too —
   * repainting only the (hidden) proxies would leave a 5 000-object scene
   * entirely unstyled.
   */
  batchRoot: () => THREE.Object3D | null;
  /** Repaint request; call sites render through their normal path. */
  onInvalidate: () => void;
}

/**
 * Viewport shading switch (`display-mode`).
 *
 * Coverage has to include the batching seam: a batched object's proxy sits on
 * a non-rendered layer, and the visible surface is the batch's chunk
 * `InstancedMesh`. The rig therefore repaints **both** — document-object
 * meshes (proxies included, they stay pickable and transformable) and every
 * mesh under the batch root.
 *
 * Originals are remembered per mesh, so `"studio"` is an exact restore even
 * after several mode flips. Overrides are created once per mode application
 * and disposed on the next flip (no per-mesh leaks, no disposed-material use).
 */
export function createDisplayRig(options: DisplayRigOptions): DisplayRig {
  const { store, batchRoot } = options;
  const originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  let mode: DisplayModeId = "studio";
  let active: THREE.Material | null = null;

  const meshes = (): THREE.Mesh[] => {
    const found: THREE.Mesh[] = [];
    for (const root of store.list()) {
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh === true) found.push(child as THREE.Mesh);
      });
    }
    const batches = batchRoot();
    batches?.traverse((child) => {
      if ((child as THREE.Mesh).isMesh === true) found.push(child as THREE.Mesh);
    });
    return found;
  };

  const dropOverride = (): void => {
    if (!active) return;
    active.dispose();
    active = null;
  };

  const apply = (): void => {
    for (const mesh of meshes()) {
      if (!originals.has(mesh)) originals.set(mesh, mesh.material);
      if (mode === "studio") {
        mesh.material = originals.get(mesh)!;
        continue;
      }
      if (!active) active = OVERRIDE_MATERIALS[mode]();
      mesh.material = active;
    }
    if (mode === "studio") dropOverride();
    options.onInvalidate();
  };

  return {
    setMode(next: DisplayModeId): void {
      if (next === mode) {
        // Same mode, but freshly mounted meshes may still be unstyled.
        if (next !== "studio") apply();
        return;
      }
      dropOverride();
      mode = next;
      apply();
    },
    get mode(): DisplayModeId {
      return mode;
    },
    refresh(): void {
      if (mode === "studio") return;
      apply();
    },
    dispose(): void {
      mode = "studio";
      apply();
      dropOverride();
    },
  };
}
