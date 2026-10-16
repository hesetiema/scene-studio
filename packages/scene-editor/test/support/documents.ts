import { createDefaultViewState } from "../../src/core/document/default-view";
import {
  SCHEMA_VERSION,
  type SceneDocument,
  type SceneObjectDTO,
} from "../../src/core/document/schema";

/** Current-version document for tests. Prefer this over inline literals. */
export function sceneDocument(overrides: Partial<SceneDocument> = {}): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "scene-1",
    revision: 0,
    objects: [],
    view: createDefaultViewState(),
    ...overrides,
  };
}

/** A single mesh object fixture. */
export function sceneObject(overrides: Partial<SceneObjectDTO> = {}): SceneObjectDTO {
  return {
    id: "obj-1",
    type: "mesh",
    name: "Box",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...overrides,
  };
}

/** Historical v1 document — only for migration coverage. */
export function v1SceneDocument() {
  return { schemaVersion: 1, sceneId: "scene-1", revision: 0, objects: [] };
}
