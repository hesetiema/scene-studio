// Core public surface (D4): domain model, schema, commands, errors, controller.
export { SCENE_EDITOR_VERSION } from "./bootstrap-version";
export {
  SceneDocumentSchema,
  SceneObjectSchema,
  type SceneDocument,
  type SceneObjectDTO,
  type EulerXYZ,
  type Vec3,
} from "./core/document/schema";
export { parseSceneDocument } from "./core/document/parse";
export { validateHierarchy } from "./core/document/hierarchy";
export { SceneEditorError, SceneErrorCode } from "./core/events/errors";
export { createConflictError, type ConflictDocuments } from "./core/events/conflict";
export { AssetCache, type AssetLoader, type LoadedAsset } from "./assets/asset-cache";
export { AssetError, AssetErrorCode } from "./assets/asset-error";
export {
  createGltfAssetLoader,
  SUPPORTED_ASSET_FORMATS,
  type GltfAssetLoaderOptions,
  type MinimalGltfLoader,
} from "./assets/gltf-asset-loader";
export {
  createResolverAssetLoader,
  type AssetResolver,
  type ResolverAssetLoaderOptions,
} from "./assets/resolver-asset-loader";
export type {
  SceneEditorPlugin,
  PluginContext,
  PluginEditorApi,
} from "./plugins/plugin";
export { CommandHistory, type Command, type HistoryState } from "./core/history/command-history";
export { TransformCommand } from "./core/commands/transform-command";
export { EditorController } from "./runtime/editor-controller";
export { FakeRuntime } from "./runtime/fake-runtime";
export { DisposerStack } from "./runtime/disposer-stack";
export { SelectionManager } from "./runtime/selection-manager";
export { TypedEventBus } from "./runtime/typed-event-bus";
export type {
  RuntimeContract,
  RuntimeEventBus,
  RuntimeEventMap,
  Transform,
} from "./runtime/runtime-contract";
