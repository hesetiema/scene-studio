import * as THREE from "three";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";

export interface CreateRendererOptions {
  antialias?: boolean;
  maxPixelRatio?: number;
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
