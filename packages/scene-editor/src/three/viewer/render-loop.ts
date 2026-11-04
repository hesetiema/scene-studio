import type * as THREE from "three";
import type { RendererHandle } from "../renderer-handle";
import type { OrbitControlsLike } from "./camera-rig";

export interface RenderLoop {
  render(): void;
  dispose(): void;
}

export interface RenderLoopOptions {
  renderer: RendererHandle;
  scene: THREE.Scene;
  camera: THREE.Camera;
  getOrbit: () => OrbitControlsLike | null;
}

/**
 * Single render entry point (reference: three-gltf-viewer's `Viewer#render`).
 *
 * Re-entrancy guard: OrbitControls dispatches "change" from `update()`, and the
 * change listener calls back into `render()` — unguarded this recurses until the
 * stack overflows (found by the D10 perf bench).
 */
export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  let rendering = false;
  let disposed = false;

  return {
    render(): void {
      if (rendering || disposed) return;
      rendering = true;
      try {
        options.getOrbit()?.update?.();
        options.renderer.render(options.scene, options.camera);
      } finally {
        rendering = false;
      }
    },
    dispose(): void {
      disposed = true;
    },
  };
}
