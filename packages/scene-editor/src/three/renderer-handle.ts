import type * as THREE from "three";

/**
 * Narrow structural slice of THREE.WebGLRenderer that the runtime needs.
 * Lets tests inject stubs without a real GPU context.
 */
export interface RendererHandle {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(value: number): void;
  dispose(): void;
}
