// Core public surface (D4): domain model, schema, commands, errors, controller.
export { SCENE_EDITOR_VERSION } from "./bootstrap-version";
export {
  SCHEMA_VERSION,
  SceneDocumentSchema,
  SceneObjectSchema,
  ViewStateSchema,
  PrimitiveGeometrySchema,
  MaterialSchema,
  AdditionalLightSchema,
  type SceneDocument,
  type SceneObjectDTO,
  type SceneObjectType,
  type ViewState,
  type PrimitiveGeometry,
  type MaterialDTO,
  type AdditionalLightDTO,
  type EulerXYZ,
  type Vec3,
} from "./core/document/schema";
export {
  DEFAULT_VIEW_STATE,
  createDefaultViewState,
} from "./core/document/default-view";
export {
  migrateSceneDocument,
  migrations,
  type Migration,
  type MigrationReport,
  type MigrationResult,
} from "./core/document/migrations";
export { parseSceneDocument, type ParseSceneDocumentOptions } from "./core/document/parse";
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
export {
  createUniversalAssetLoader,
  inspectModel,
  UNIVERSAL_SUPPORTED_FORMATS,
  type UniversalAssetLoaderOptions,
  type Supported3DFormat,
  type ModelMetadata,
} from "./assets/universal-asset-loader";
export type {
  SceneEditorPlugin,
  PluginContext,
  PluginEditorApi,
} from "./plugins/plugin";
export { CommandHistory, type Command, type HistoryState } from "./core/history/command-history";
export { TransformCommand } from "./core/commands/transform-command";
export { EditorController } from "./runtime/editor-controller";
export {
  createSceneEditor,
  type SceneEditor,
  type SceneEditorEventMap,
  type SceneEditorElementEventMap,
  type CreateSceneEditorOptions,
} from "./runtime/create-scene-editor";
export { handleEditorKeyCommand, type KeyboardLike } from "./runtime/keyboard";
export { FakeRuntime } from "./runtime/fake-runtime";
export { DisposerStack } from "./runtime/disposer-stack";
export { SelectionManager } from "./runtime/selection-manager";
export { TypedEventBus } from "./runtime/typed-event-bus";
export type {
  EnvironmentPreset,
  MorphTargetInfo,
  RuntimeContract,
  RuntimeEventBus,
  RuntimeEventMap,
  Transform,
} from "./runtime/runtime-contract";
