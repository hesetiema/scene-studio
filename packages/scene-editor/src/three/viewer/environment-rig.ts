import * as THREE from "three";
import type { ViewState } from "../../core/document/schema";

export type EnvironmentView = ViewState["environment"];

export interface EnvironmentRig {
  readonly grid: THREE.GridHelper;
  readView(): EnvironmentView;
  applyView(view: EnvironmentView): void;
  setBackground(background: string | null): void;
  setGridVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Backdrop + floor grid (reference: `updateBackground` / `updateDisplay`).
 * `background: null` stays transparent to preserve the pre-D22 look.
 */
export function createEnvironmentRig(
  scene: THREE.Scene,
  initial: EnvironmentView,
): EnvironmentRig {
  const grid = new THREE.GridHelper(10, 10);
  grid.visible = initial.gridVisible;
  scene.add(grid);

  const rig: EnvironmentRig = {
    grid,
    readView(): EnvironmentView {
      return {
        background:
          scene.background instanceof THREE.Color ? `#${scene.background.getHexString()}` : null,
        gridVisible: grid.visible,
      };
    },
    applyView(view: EnvironmentView): void {
      rig.setBackground(view.background);
      rig.setGridVisible(view.gridVisible);
    },
    setBackground(background: string | null): void {
      scene.background = background === null ? null : new THREE.Color(background);
    },
    setGridVisible(visible: boolean): void {
      grid.visible = visible;
    },
    dispose(): void {
      scene.remove(grid);
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) material.dispose();
    },
  };

  rig.setBackground(initial.background);
  return rig;
}
