// Three runtime public surface (D4/D14): advanced integration only.
export {
  ThreeRuntime,
  type ThreeRuntimeOptions,
  type TransformMode,
} from "./three/three-runtime";
export { createRenderer, type CreateRendererOptions } from "./three/create-renderer";
export type { RendererHandle } from "./three/renderer-handle";
export {
  createTransformControlsBinding,
  type TransformControlsBinding,
  type TransformControlsBindingOptions,
  type TransformControlsLike,
  type TransformSnapshot,
} from "./three/transform-controls-binding";
export { createPicker, type Picker, type PickerOptions, type RaycastHit } from "./three/picker";
export {
  createSelectionHighlightPlugin,
  type SelectionHighlightOptions,
} from "./three/selection-highlight-plugin";

