import { describe, expect, it } from "vitest";
import {
  SceneDocumentSchema,
  type SceneDocument,
  type SceneObjectDTO,
} from "../../src/core/document/schema";

const validObject: SceneObjectDTO = {
  id: "obj-1",
  type: "mesh",
  name: "Box",
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const validDoc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "scene-1",
  revision: 0,
  objects: [validObject],
};

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
});
