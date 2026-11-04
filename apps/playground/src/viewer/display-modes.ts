import * as THREE from "three";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import type { DisplayMode } from "./viewer-state";

type OverrideMode = Exclude<DisplayMode, "studio">;

/**
 * Material factory per shading mode. Overrides are owned here and disposed when
 * the mode changes — previously every switch leaked a material per mesh.
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

export interface DisplayModes {
  apply(mode: DisplayMode): void;
  /** Re-apply after a document swap (new meshes need the override). */
  reset(mode: DisplayMode): void;
  dispose(): void;
}

/**
 * Shading switcher for the loaded scene graph.
 *
 * Only document objects are touched (`scene` also holds grid, lights and the
 * gizmo helper — traversing the whole scene used to repaint those too).
 */
export function createDisplayModes(
  el: SceneEditorElement,
  getRuntime: () => ThreeRuntime | null,
): DisplayModes {
  const originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const overrides = new WeakSet<THREE.Material>();

  const modelMeshes = (rt: ThreeRuntime): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    // A document may not be loaded yet (keys/toolbar pressed during boot).
    let objects: readonly { id: string }[] = [];
    try {
      objects = el.getDocument().objects;
    } catch {
      return meshes;
    }

    for (const dto of objects) {
      const root = rt.getObjectById(dto.id);
      if (!root) continue;
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
      });
    }
    return meshes;
  };

  const releaseOverride = (material: THREE.Material | THREE.Material[]): void => {
    const list = Array.isArray(material) ? material : [material];
    for (const item of list) {
      if (!overrides.has(item)) continue;
      overrides.delete(item);
      item.dispose();
    }
  };

  const apply = (mode: DisplayMode): void => {
    const rt = getRuntime();
    if (!rt) return;

    for (const mesh of modelMeshes(rt)) {
      if (!originals.has(mesh)) originals.set(mesh, mesh.material);
      const original = originals.get(mesh);
      if (!original) continue;

      releaseOverride(mesh.material);

      if (mode === "studio") {
        mesh.material = original;
        continue;
      }

      const material = OVERRIDE_MATERIALS[mode]();
      overrides.add(material);
      mesh.material = material;
    }
    rt.render();
  };

  return {
    apply,
    reset(mode: DisplayMode): void {
      if (mode !== "studio") apply(mode);
    },
    dispose(): void {
      const rt = getRuntime();
      if (rt) {
        for (const mesh of modelMeshes(rt)) {
          const original = originals.get(mesh);
          if (!original) continue;
          releaseOverride(mesh.material);
          mesh.material = original;
        }
        rt.render();
      }
    },
  };
}
