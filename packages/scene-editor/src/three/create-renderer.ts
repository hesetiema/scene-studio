import * as THREE from "three";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";

export interface CreateRendererOptions {
  antialias?: boolean;
  maxPixelRatio?: number;
  /**
   * Transparent canvas (default `true`). With `alpha: true` three clears to
   * alpha 0, so `scene.background === null` lets the page show through — the
   * model-viewer default. Pass `false` for an opaque canvas (lower composition
   * cost on low-end GPUs, but no transparent backgrounds).
   */
  alpha?: boolean;
}

/**
 * Single creation site for the v0.1 WebGLRenderer (D1).
 * Failures surface as SceneEditorError(RENDER_INIT_FAILED).
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): THREE.WebGLRenderer {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      alpha: options.alpha ?? true,
    });
    const cap = options.maxPixelRatio ?? 2;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, cap));
    return renderer;
  } catch (cause) {
    throw new SceneEditorError(
      SceneErrorCode.RenderInitFailed,
      "WebGLRenderer initialization failed",
      { cause },
    );
  }
}
