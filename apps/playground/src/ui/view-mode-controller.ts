import * as THREE from "three";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export type DisplayMode = "studio" | "xray" | "wireframe" | "normal" | "clay";

type OverrideMode = Exclude<DisplayMode, "studio">;

/**
 * Material factory per shading mode. Overrides are owned by this controller and
 * disposed when the mode changes — previously every switch leaked a material per
 * mesh (the old code allocated but never freed them).
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

/**
 * Shading / display-mode switcher for the loaded scene graph.
 *
 * Only document objects are touched (`scene` also holds grid, lights and the
 * gizmo helper — traversing the whole scene used to repaint those too).
 */
export class ViewModeController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  #mode: DisplayMode = "studio";
  readonly #originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  readonly #overrides = new WeakSet<THREE.Material>();

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  get mode(): DisplayMode {
    return this.#mode;
  }

  apply(mode: DisplayMode): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    const meshes = this.#modelMeshes(rt);
    for (const mesh of meshes) {
      if (!this.#originals.has(mesh)) this.#originals.set(mesh, mesh.material);
      const original = this.#originals.get(mesh);
      if (!original) continue;

      this.#releaseOverride(mesh.material);

      if (mode === "studio") {
        mesh.material = original;
        continue;
      }

      const material = OVERRIDE_MATERIALS[mode]();
      this.#overrides.add(material);
      mesh.material = material;
    }

    this.#mode = mode;
    rt.render();
    this.#syncTabs();
  }

  /** Re-apply the active mode — call after a new document has been loaded. */
  reset(): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    if (this.#mode === "studio") {
      this.#syncTabs();
      return;
    }
    this.apply(this.#mode);
  }

  /** Restore studio shading and free every generated material. */
  dispose(): void {
    const rt = this.#getRuntime();
    if (rt) {
      for (const mesh of this.#modelMeshes(rt)) {
        const original = this.#originals.get(mesh);
        if (!original) continue;
        this.#releaseOverride(mesh.material);
        mesh.material = original;
      }
      rt.render();
    }
    this.#mode = "studio";
  }

  #modelMeshes(rt: ThreeRuntime): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    // A document may not be loaded yet (keys/toolbar pressed during boot).
    let objects: readonly { id: string }[] = [];
    try {
      objects = this.#el.getDocument().objects;
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
  }

  #releaseOverride(material: THREE.Material | THREE.Material[]): void {
    const list = Array.isArray(material) ? material : [material];
    for (const item of list) {
      if (!this.#overrides.has(item)) continue;
      this.#overrides.delete(item);
      item.dispose();
    }
  }

  #syncTabs(): void {
    document.querySelectorAll<HTMLElement>(".mode-tab[data-mode]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === this.#mode);
    });
  }
}
