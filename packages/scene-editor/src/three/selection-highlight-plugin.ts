import * as THREE from "three";
import type { PluginContext, SceneEditorPlugin } from "../plugins/plugin";

export interface SelectionHighlightOptions {
  /** Emissive color applied to selected meshes. */
  color?: number;
  /** Emissive intensity. */
  intensity?: number;
}

/**
 * Example plugin: tints selected objects' materials with an emissive highlight.
 * Demonstrates `install(context)` + event subscription + disposer cleanup.
 */
export function createSelectionHighlightPlugin(
  options: SelectionHighlightOptions = {},
): SceneEditorPlugin {
  const color = options.color ?? 0x3fb56f;
  const intensity = options.intensity ?? 0.55;

  return {
    id: "selection-highlight",
    install(context: PluginContext) {
      const runtime = context.runtime as {
        getObjectById?: (id: string) => THREE.Object3D | undefined;
      };
      if (!runtime.getObjectById) return; // non-three runtime: no-op

      interface Applied {
        material: THREE.MeshStandardMaterial;
        prevColor: number;
        prevIntensity: number;
      }
      const applied = new Map<string, Applied[]>();

      const clear = (): void => {
        for (const entries of applied.values()) {
          for (const a of entries) {
            a.material.emissive.setHex(a.prevColor);
            a.material.emissiveIntensity = a.prevIntensity;
          }
        }
        applied.clear();
      };

      const highlight = (ids: readonly string[]): void => {
        clear();
        for (const id of ids) {
          const obj = runtime.getObjectById!(id);
          if (!obj) continue;
          const entries: Applied[] = [];
          obj.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material)
              ? mesh.material
              : mesh.material
                ? [mesh.material]
                : [];
            for (const mat of materials) {
              const std = mat as THREE.MeshStandardMaterial;
              if (!std.emissive) continue;
              entries.push({
                material: std,
                prevColor: std.emissive.getHex(),
                prevIntensity: std.emissiveIntensity ?? 0,
              });
              std.emissive.setHex(color);
              std.emissiveIntensity = intensity;
            }
          });
          applied.set(id, entries);
        }
      };

      const off = context.on("selection-change", (payload) => {
        highlight(payload.ids);
      });
      context.addDisposer(() => {
        off();
        clear();
      });
    },
  };
}
