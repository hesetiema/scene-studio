import "./styles/scene-editor.css";

export { defineSceneEditor } from "./element/register";
export {
  SceneEditorElement,
  CAPTURED_COMBOS,
  type CameraOrbit,
  type HotspotConfig,
  type HotspotData,
  type HotspotVector,
  type VisibilityObserver,
  type VisibilityObserverFactory,
} from "./element/scene-editor-element";
export type { SceneEditorElementEventMap } from "./runtime/create-scene-editor";
export { createSrcDocument, SRC_ASSET_ID, SRC_SCENE_ID } from "./element/src-document";
