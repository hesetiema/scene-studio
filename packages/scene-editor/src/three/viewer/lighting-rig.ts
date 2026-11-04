import * as THREE from "three";
import type { ViewState } from "../../core/document/schema";
import { toHex } from "./color";

export type LightingView = ViewState["lights"];

export interface LightingRig {
  readonly lights: readonly THREE.Light[];
  readView(): LightingView;
  applyView(view: LightingView): void;
  dispose(): void;
}

/**
 * Ambient + directional rig (reference: `addLights` / `updateLights`).
 * Engine state only — lights are persisted through `view`, never the document (D3/D22).
 */
export function createLightingRig(scene: THREE.Scene, initial: LightingView): LightingRig {
  const ambient = new THREE.AmbientLight(
    new THREE.Color(initial.ambient.color),
    initial.ambient.intensity,
  );
  const directional = new THREE.DirectionalLight(
    new THREE.Color(initial.directional.color),
    initial.directional.intensity,
  );
  const [dx, dy, dz] = initial.directional.position;
  directional.position.set(dx, dy, dz);
  scene.add(ambient, directional);

  return {
    lights: [ambient, directional],
    readView(): LightingView {
      return {
        ambient: {
          color: toHex(ambient.color),
          intensity: ambient.intensity,
        },
        directional: {
          color: toHex(directional.color),
          intensity: directional.intensity,
          position: [
            directional.position.x,
            directional.position.y,
            directional.position.z,
          ],
        },
      };
    },
    applyView(view: LightingView): void {
      ambient.color.set(view.ambient.color);
      ambient.intensity = view.ambient.intensity;
      directional.color.set(view.directional.color);
      directional.intensity = view.directional.intensity;
      const [x, y, z] = view.directional.position;
      directional.position.set(x, y, z);
    },
    dispose(): void {
      scene.remove(ambient, directional);
      ambient.dispose();
      directional.dispose();
    },
  };
}
