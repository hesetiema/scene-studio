// Three runtime public surface (D4/D14): advanced integration only.
export { ThreeRuntime, type ThreeRuntimeOptions } from "./three/three-runtime";
export { createRenderer, type CreateRendererOptions } from "./three/create-renderer";
export type { RendererHandle } from "./three/renderer-handle";
export {
  createTransformControlsAdapter,
  type TransformControlsAdapter,
  type TransformControlsAdapterOptions,
  type TransformControlsLike,
} from "./three/addons/transform-controls-adapter";
