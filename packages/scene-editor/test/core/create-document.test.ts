import { describe, expect, it } from "vitest";
import {
  applyViewPatch,
  assetDisplayName,
  createDocumentFromAsset,
  createEmptyDocument,
  createSceneDocument,
} from "../../src/core/document/create";
import { createDefaultViewState, createPreviewViewState } from "../../src/core/document/default-view";
import { SceneDocumentSchema, SCHEMA_VERSION } from "../../src/core/document/schema";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import { parseSceneDocument } from "../../src/core/document/parse";

describe("applyViewPatch", () => {
  it("merges one leaf and leaves the rest untouched", () => {
    const base = createDefaultViewState();
    const view = applyViewPatch(base, { environment: { gridVisible: false } });

    expect(view.environment.gridVisible).toBe(false);
    expect(view.environment.background).toBe(base.environment.background);
    expect(view.camera).toEqual(base.camera);
    expect(view.lights).toEqual(base.lights);
  });

  it("merges nested light slots independently", () => {
    const view = applyViewPatch(createDefaultViewState(), {
      lights: { ambient: { intensity: 0 } },
    });

    expect(view.lights.ambient).toEqual({ color: "#ffffff", intensity: 0 });
    // The directional light is untouched, not reset to a default of its own.
    expect(view.lights.directional.intensity).toBe(1);
  });

  it("never mutates or aliases the base view", () => {
    const base = createDefaultViewState();
    const view = applyViewPatch(base, { camera: { fov: 30 } });

    expect(base.camera.fov).toBe(60);
    view.camera.position[0] = 99;
    expect(base.camera.position[0]).toBe(6);
  });

  it("replaces `additional` wholesale instead of merging arrays", () => {
    const base = createDefaultViewState();
    base.lights.additional = [
      { kind: "point", color: "#ffffff", intensity: 1, position: [1, 1, 1] },
    ];
    const view = applyViewPatch(base, { lights: { additional: [] } });

    expect(view.lights.additional).toEqual([]);
  });
});

describe("createSceneDocument", () => {
  it("produces a document the parser accepts", () => {
    const doc = createSceneDocument();

    expect(() => SceneDocumentSchema.parse(doc)).not.toThrow();
    expect(() => parseSceneDocument(doc)).not.toThrow();
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.objects).toEqual([]);
    expect(doc.view).toEqual(createDefaultViewState());
  });

  it("clones the objects it is given", () => {
    const object = {
      id: "box",
      type: "mesh" as const,
      name: "Box",
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const doc = createSceneDocument({ objects: [object] });

    expect(doc.objects[0]).not.toBe(object);
    expect(doc.objects[0]!.position).not.toBe(object.position);
    expect(doc.objects[0]).toEqual(object);
  });

  it("keeps caller-supplied ids and revision", () => {
    const doc = createSceneDocument({ sceneId: "kitchen", revision: 7 });

    expect(doc.sceneId).toBe("kitchen");
    expect(doc.revision).toBe(7);
  });

  it("starts from a caller-supplied baseline", () => {
    const doc = createEmptyDocument({ baseView: createPreviewViewState() });

    expect(doc.view.environment.gridVisible).toBe(false);
    expect(doc.view.camera.fov).toBe(30);
  });
});

describe("createDocumentFromAsset", () => {
  it("derives the ids from the asset id and keeps the format extension in the name", () => {
    const doc = createDocumentFromAsset({ assetId: "upload-1-fox.glb" });

    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]).toMatchObject({
      id: "upload-1-fox.glb-mesh",
      type: "mesh",
      assetId: "upload-1-fox.glb",
      name: "upload-1-fox.glb",
    });
    expect(doc.sceneId).toBe("scene-upload-1-fox.glb");
    expect(() => SceneDocumentSchema.parse(doc)).not.toThrow();
  });

  it("falls back to the url as the asset id and takes the name from it", () => {
    const doc = createDocumentFromAsset({ url: "https://cdn.test/models/Milk%20Truck.glb?v=2" });

    expect(doc.objects[0]!.assetId).toBe("https://cdn.test/models/Milk%20Truck.glb?v=2");
    expect(doc.objects[0]!.name).toBe("Milk Truck.glb");
  });

  it("accepts explicit ids, placement and a preview baseline", () => {
    const doc = createDocumentFromAsset({
      assetId: "fox",
      name: "Fox",
      objectId: "fox-root",
      sceneId: "preview",
      position: [1, 2, 3],
      scale: [2, 2, 2],
      baseView: createPreviewViewState(),
    });

    expect(doc.sceneId).toBe("preview");
    expect(doc.objects[0]).toMatchObject({
      id: "fox-root",
      name: "Fox",
      position: [1, 2, 3],
      scale: [2, 2, 2],
    });
    expect(doc.view.environment.gridVisible).toBe(false);
  });

  it("rejects a call with neither assetId nor url", () => {
    expect(() => createDocumentFromAsset({})).toThrow(SceneEditorError);
    try {
      createDocumentFromAsset({});
    } catch (error) {
      expect((error as SceneEditorError).code).toBe(SceneErrorCode.Validation);
    }
  });

  it("names the last path segment, decoded, without query or hash", () => {
    expect(assetDisplayName("https://cdn.test/a/b/Water%20Bottle.glb?x=1#y")).toBe(
      "Water Bottle.glb",
    );
    expect(assetDisplayName("model.glb")).toBe("model.glb");
    // A trailing slash has no name; the model-viewer-style fallback applies.
    expect(assetDisplayName("https://cdn.test/")).toBe("model");
  });
});
