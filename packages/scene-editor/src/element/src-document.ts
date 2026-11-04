import type { SceneDocument } from "../core/document/schema";
import { SCHEMA_VERSION } from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";

/** Asset id reserved for the `src` preview path. */
export const SRC_ASSET_ID = "__src__";

/**
 * Stable scene id: reloading the same source keeps the recorded view instead
 * of resetting the camera (the facade only re-emits `view-change` on a new id).
 */
export const SRC_SCENE_ID = "__scene_editor_src__";

/**
 * `<scene-editor src="model.glb">` is document sugar: one mesh object pointing
 * at the reserved asset id, framed by the engine defaults. Everything downstream
 * (assets, picking, gizmos, history) sees a normal document, so the preview path
 * upgrades to editing without a second code path.
 */
export function createSrcDocument(url: string): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: SRC_SCENE_ID,
    revision: 0,
    objects: [
      {
        id: SRC_ASSET_ID,
        type: "mesh",
        name: displayName(url),
        assetId: SRC_ASSET_ID,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    view: createDefaultViewState(),
  };
}

function displayName(url: string): string {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  const last = clean.split("/").pop() ?? clean;
  try {
    return decodeURIComponent(last) || "model";
  } catch {
    return last || "model";
  }
}
