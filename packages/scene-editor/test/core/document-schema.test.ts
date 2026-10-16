import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  SceneDocumentSchema,
  ViewStateSchema,
  type SceneObjectDTO,
} from "../../src/core/document/schema";
import { createDefaultViewState } from "../../src/core/document/default-view";

const validObject: SceneObjectDTO = {
  id: "obj-1",
  type: "mesh",
  name: "Box",
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const validDoc = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "scene-1",
  revision: 0,
  objects: [validObject],
  view: createDefaultViewState(),
};

describe("ViewStateSchema", () => {
  it("accepts the engine defaults", () => {
    expect(ViewStateSchema.safeParse(createDefaultViewState()).success).toBe(true);
  });

  it("accepts a custom view", () => {
    const view = {
      camera: { position: [-2, 8, 3], target: [1, 0, -1], fov: 45 },
      lights: {
        ambient: { color: "#ff00aa", intensity: 0.2 },
        directional: { color: "#00ff00", intensity: 2, position: [0, 5, 0] },
      },
      environment: { background: "#101010", gridVisible: false },
    };
    expect(ViewStateSchema.safeParse(view).success).toBe(true);
  });

  it("requires #rrggbb colours", () => {
    const bad = createDefaultViewState();
    bad.lights.ambient.color = "white";
    expect(ViewStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-positive fov and negative intensity", () => {
    const zeroFov = createDefaultViewState();
    zeroFov.camera.fov = 0;
    expect(ViewStateSchema.safeParse(zeroFov).success).toBe(false);

    const negative = createDefaultViewState();
    negative.lights.ambient.intensity = -1;
    expect(ViewStateSchema.safeParse(negative).success).toBe(false);
  });

  it("rejects unknown keys inside the view (strict)", () => {
    const bad = { ...createDefaultViewState(), near: 0.1 };
    expect(ViewStateSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SceneDocumentSchema", () => {
  it("accepts a minimal valid document", () => {
    const result = SceneDocumentSchema.safeParse(validDoc);
    expect(result.success).toBe(true);
  });

  it("accepts assetId, parentId and metadata when present", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [
        {
          ...validObject,
          assetId: "asset-42",
          parentId: "obj-root",
          metadata: { locked: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires rotation to be a 3-number tuple (Euler XYZ radians)", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, rotation: [0, 0] }],
    });
    expect(bad.success).toBe(false);
  });

  it("requires schemaVersion, sceneId and revision", () => {
    expect(SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: undefined }).success).toBe(false);
    expect(SceneDocumentSchema.safeParse({ ...validDoc, sceneId: "" }).success).toBe(false);
    expect(SceneDocumentSchema.safeParse({ ...validDoc, revision: -1 }).success).toBe(false);
  });

  it("rejects unknown object types", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, type: "light" }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const bad = SceneDocumentSchema.safeParse({ ...validDoc, extra: true });
    expect(bad.success).toBe(false);
  });

  it("metadata must be a plain object when present", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, metadata: "nope" }],
    });
    expect(bad.success).toBe(false);
  });

  it("requires the view section (v2 is fully explicit)", () => {
    const { view: _view, ...withoutView } = validDoc;
    expect(SceneDocumentSchema.safeParse(withoutView).success).toBe(false);
  });

  it("rejects the previous schema version literal", () => {
    expect(SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: 1 }).success).toBe(false);
  });
});
