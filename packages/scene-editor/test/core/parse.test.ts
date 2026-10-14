import { describe, expect, it } from "vitest";
import { parseSceneDocument } from "../../src/core/document/parse";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import type { SceneDocument } from "../../src/core/document/schema";

const validDoc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "scene-1",
  revision: 0,
  objects: [],
};

describe("parseSceneDocument", () => {
  it("returns the parsed document on success", () => {
    expect(parseSceneDocument(validDoc)).toEqual(validDoc);
  });

  it("throws SceneEditorError with validation code on invalid input", () => {
    try {
      parseSceneDocument({ ...validDoc, revision: -5 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).detail).toMatchObject({
        issues: expect.any(Array),
      });
    }
  });
});
