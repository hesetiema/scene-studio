// Three runtime public surface (D4/D14): advanced integration only.
export {
  ThreeRuntime,
  type ThreeRuntimeOptions,
  type TransformMode,
  type OrbitControlsLike,
  type AnimationClipInfo,
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

// Composable viewer rigs — the same split ThreeRuntime uses internally.
export {
  createCameraRig,
  type CameraRig,
  type CameraRigOptions,
  type CameraView,
} from "./three/viewer/camera-rig";
export {
  createLightingRig,
  type LightingRig,
  type LightingView,
} from "./three/viewer/lighting-rig";
export {
  createEnvironmentRig,
  type EnvironmentRig,
  type EnvironmentView,
} from "./three/viewer/environment-rig";
export { createObjectStore, type ObjectStore, type ObjectStoreOptions } from "./three/viewer/object-store";
export { createGizmoRig, type GizmoRig, type GizmoRigOptions, type GizmoControls } from "./three/viewer/gizmo-rig";
export { createAnimationRig, type AnimationRig } from "./three/viewer/animation-rig";
export { createRenderLoop, type RenderLoop, type RenderLoopOptions } from "./three/viewer/render-loop";
