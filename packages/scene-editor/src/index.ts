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
export { SceneEditorError, SceneErrorCode } from "./core/events/errors";
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
