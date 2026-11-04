import * as THREE from "three";
import type { ViewState } from "../../core/document/schema";

export type EnvironmentView = ViewState["environment"];

/** IBL strength used when the document omits it (1 = raw environment luminance). */
export const DEFAULT_IBL_INTENSITY = 1;

export interface EnvironmentRigOptions {
  /**
   * Real WebGL renderer — PMREM needs a GPU context. WebGPU renderers and test
   * stubs do not expose `isWebGLRenderer`, so IBL silently degrades to plain lights.
   */
  renderer?: unknown;
  /** Fired once the environment map finished generating (the runtime re-renders). */
  onEnvironmentReady?: () => void;
}

export interface EnvironmentRig {
  readonly grid: THREE.GridHelper;
  readView(): EnvironmentView;
  applyView(view: EnvironmentView): void;
  setBackground(background: string | null): void;
  setGridVisible(visible: boolean): void;
  /** 0 = pure analytic lights; > 0 = environment map luminance multiplier. */
  setIblIntensity(intensity: number): void;
  dispose(): void;
}

/**
 * Backdrop + floor grid + image-based lighting (reference: `updateBackground` /
 * `updateDisplay` / `updateEnvironment`).
 *
 * `background: null` stays transparent to preserve the pre-D22 look. The
 * environment map is three's built-in `RoomEnvironment`, prefiltered through
 * PMREM — no network asset, and metals/glass pick up reflections instead of
 * rendering black under analytic lights alone.
 */
export function createEnvironmentRig(
  scene: THREE.Scene,
  initial: EnvironmentView,
  options: EnvironmentRigOptions = {},
): EnvironmentRig {
  const grid = new THREE.GridHelper(10, 10);
  grid.visible = initial.gridVisible;
  scene.add(grid);

  let iblIntensity = initial.iblIntensity ?? DEFAULT_IBL_INTENSITY;
  let environmentTexture: THREE.Texture | null = null;
  let environmentRequest: Promise<void> | null = null;
  let disposed = false;

  const renderer = options.renderer as { isWebGLRenderer?: boolean } | null | undefined;

  const applyIbl = (): void => {
    if (iblIntensity <= 0 || !environmentTexture) {
      scene.environment = null;
      return;
    }
    scene.environment = environmentTexture;
    scene.environmentIntensity = iblIntensity;
  };

  /** Lazily prefilter the built-in studio environment; never rejects. */
  const ensureEnvironment = (): void => {
    if (environmentTexture || environmentRequest || disposed) return;
    if (renderer?.isWebGLRenderer !== true) return;

    environmentRequest = (async () => {
      try {
        const { RoomEnvironment } = await import(
          "three/examples/jsm/environments/RoomEnvironment.js"
        );
        if (disposed) return;

        const room = new RoomEnvironment();
        const pmrem = new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer);
        environmentTexture = pmrem.fromScene(room, 0.04).texture;
        pmrem.dispose();
        (room as { dispose?: () => void }).dispose?.();

        applyIbl();
        options.onEnvironmentReady?.();
      } catch {
        // No usable GPU context — keep rendering with analytic lights only.
      } finally {
        environmentRequest = null;
      }
    })();
  };

  const rig: EnvironmentRig = {
    grid,
    readView(): EnvironmentView {
      return {
        background:
          scene.background instanceof THREE.Color ? `#${scene.background.getHexString()}` : null,
        gridVisible: grid.visible,
        iblIntensity,
      };
    },
    applyView(view: EnvironmentView): void {
      rig.setBackground(view.background);
      rig.setGridVisible(view.gridVisible);
      rig.setIblIntensity(view.iblIntensity ?? DEFAULT_IBL_INTENSITY);
    },
    setBackground(background: string | null): void {
      scene.background = background === null ? null : new THREE.Color(background);
    },
    setGridVisible(visible: boolean): void {
      grid.visible = visible;
    },
    setIblIntensity(intensity: number): void {
      iblIntensity = Number.isFinite(intensity)
        ? Math.max(0, intensity)
        : DEFAULT_IBL_INTENSITY;

      if (iblIntensity <= 0) {
        scene.environment = null;
        return;
      }
      applyIbl();
      ensureEnvironment();
    },
    dispose(): void {
      disposed = true;
      scene.remove(grid);
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) material.dispose();

      scene.environment = null;
      environmentTexture?.dispose();
      environmentTexture = null;
    },
  };

  rig.setBackground(initial.background);
  rig.setGridVisible(initial.gridVisible);
  rig.setIblIntensity(iblIntensity);
  return rig;
}
