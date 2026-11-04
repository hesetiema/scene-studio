import * as THREE from "three";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export interface MaterialValues {
  color: string;
  /** 0..1 */
  opacity: number;
  /** 0..1 */
  metalness: number;
  /** 0..1 */
  roughness: number;
}

export const DEFAULT_MATERIAL_VALUES: MaterialValues = {
  color: "#d9d9d9",
  opacity: 1,
  metalness: 0,
  roughness: 1,
};

/** 材质原样，供「恢复原材质」精确还原。 */
interface Snapshot {
  material: THREE.Material;
  color: THREE.Color | null;
  opacity: number;
  transparent: boolean;
  metalness: number | null;
  roughness: number | null;
}

type PatchedMaterial = THREE.Material & {
  color?: THREE.Color;
  metalness?: number;
  roughness?: number;
};

/**
 * 选中部件的材质覆盖（颜色 / 透明度 / 金属度 / 粗糙度）。
 *
 * 与部件分解一样是运行时预览：不写文档、不进撤销栈；首次应用时记录原始材质，
 * 「恢复原材质」可逐项还原。切换选中对象时先还原旧对象，面板回填新对象的当前值。
 */
export class MaterialController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  #values: MaterialValues = { ...DEFAULT_MATERIAL_VALUES };
  #selectionId: string | null = null;
  #snapshots: Snapshot[] = [];

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  get values(): MaterialValues {
    return this.#values;
  }

  /** 当前选中部件里的网格数量（0 表示没选中或没有网格）。 */
  get selectedMeshCount(): number {
    return this.#selectedMeshes().length;
  }

  /**
   * 读取选中部件当前的材质参数，用于切换选中时回填面板。
   * 没有可编辑材质时返回 null。
   */
  readSelection(): MaterialValues | null {
    for (const mesh of this.#selectedMeshes()) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        const patched = material as PatchedMaterial;
        if (!patched.color) continue;
        return {
          color: `#${patched.color.getHexString()}`,
          opacity: material.opacity,
          metalness: patched.metalness ?? 0,
          roughness: patched.roughness ?? 1,
        };
      }
    }
    return null;
  }

  /** 只更新面板记住的参数，不改变模型外观。 */
  adopt(values: MaterialValues): void {
    this.#values = { ...values };
  }

  setColor(color: string): void {
    this.#values = { ...this.#values, color };
    this.apply();
  }

  setOpacity(opacity: number): void {
    this.#values = { ...this.#values, opacity: clamp01(opacity) };
    this.apply();
  }

  setMetalness(metalness: number): void {
    this.#values = { ...this.#values, metalness: clamp01(metalness) };
    this.apply();
  }

  setRoughness(roughness: number): void {
    this.#values = { ...this.#values, roughness: clamp01(roughness) };
    this.apply();
  }

  /** 把当前参数应用到选中部件；没有选中时返回 false。 */
  apply(): boolean {
    const meshes = this.#selectedMeshes();
    if (meshes.length === 0) return false;

    this.#capture(meshes);

    const { color, opacity, metalness, roughness } = this.#values;
    for (const snapshot of this.#snapshots) {
      const material = snapshot.material as PatchedMaterial;
      if (material.color) material.color.set(color);
      material.opacity = opacity;
      material.transparent = opacity < 1 || snapshot.transparent;
      if (typeof material.metalness === "number") material.metalness = metalness;
      if (typeof material.roughness === "number") material.roughness = roughness;
      material.needsUpdate = true;
    }

    this.#getRuntime()?.render();
    return true;
  }

  /** 撤销所有材质修改，恢复模型原始外观。 */
  reset(): void {
    this.#restoreSnapshots();
    this.#selectionId = null;
    this.#getRuntime()?.render();
  }

  /**
   * 选中对象变化后调用：先还原上一个对象的材质，再让面板回填新对象的值。
   * 这里不自动套用参数 —— 避免切着看模型时把别人的材质改掉。
   */
  syncSelection(): void {
    const nextId = this.#el.selectedIds[0] ?? null;
    if (nextId === this.#selectionId) return;

    this.#restoreSnapshots();
    this.#selectionId = nextId;
    this.#getRuntime()?.render();
  }

  #capture(meshes: readonly THREE.Mesh[]): void {
    const currentId = this.#el.selectedIds[0] ?? null;
    if (this.#selectionId !== currentId) {
      this.#restoreSnapshots();
      this.#selectionId = currentId;
    }
    if (this.#snapshots.length > 0) return;

    const seen = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material || seen.has(material)) continue;
        seen.add(material);
        const patched = material as PatchedMaterial;
        this.#snapshots.push({
          material,
          color: patched.color ? patched.color.clone() : null,
          opacity: material.opacity,
          transparent: material.transparent,
          metalness: typeof patched.metalness === "number" ? patched.metalness : null,
          roughness: typeof patched.roughness === "number" ? patched.roughness : null,
        });
      }
    }
  }

  #restoreSnapshots(): void {
    for (const snapshot of this.#snapshots) {
      const material = snapshot.material as PatchedMaterial;
      if (snapshot.color && material.color) material.color.copy(snapshot.color);
      material.opacity = snapshot.opacity;
      material.transparent = snapshot.transparent;
      if (snapshot.metalness !== null) material.metalness = snapshot.metalness;
      if (snapshot.roughness !== null) material.roughness = snapshot.roughness;
      material.needsUpdate = true;
    }
    this.#snapshots = [];
  }

  #selectedMeshes(): THREE.Mesh[] {
    const rt = this.#getRuntime();
    const id = this.#el.selectedIds[0];
    if (!rt || !id) return [];

    const root = rt.getObjectById(id);
    if (!root) return [];

    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh === true) meshes.push(mesh);
    });
    return meshes;
  }
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
