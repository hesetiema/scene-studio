import type * as THREE from "three";
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

type PatchedMaterial = THREE.Material & {
  color?: THREE.Color;
  metalness?: number;
  roughness?: number;
};

/**
 * 选中部件的材质编辑（颜色 / 透明度 / 金属度 / 粗糙度）。
 *
 * 写入走 `el.setMaterial`：进文档、进撤销栈，由 SDK 负责材质 clone 和恢复。
 * 面板自身不再记录快照——之前直接改 `mesh.material` 会污染 AssetCache 里与
 * 其他实例共享的材质，而且改动在保存/撤销里都看不见。
 *
 * 拖动滑块时的连续写入由 `SetMaterialCommand.mergeWith` 合并成一步撤销。
 * `readSelection` / `selectedMeshCount` 仍从运行时读取，因为面板要显示 GLB
 * 自带的真实材质值，而不只是文档里的覆盖字段。
 */
export class MaterialController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  #values: MaterialValues = { ...DEFAULT_MATERIAL_VALUES };

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

  /** 提交一次可撤销的材质写入；没有选中时返回 false。 */
  apply(): boolean {
    const id = this.#el.selectedIds[0];
    if (!id) return false;

    const { color, opacity, metalness, roughness } = this.#values;
    this.#el.setMaterial(id, { color, opacity, metalness, roughness });
    return true;
  }

  /** 清除覆盖，恢复资产自带材质（同样是一次可撤销命令）。 */
  reset(): void {
    const id = this.#el.selectedIds[0];
    if (!id) return;
    this.#el.setMaterial(id, undefined);
  }

  /** 选中对象变化后回填面板；不自动套用参数，避免顺手改掉别的模型。 */
  syncSelection(): void {
    const values = this.readSelection();
    if (values) this.adopt(values);
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
