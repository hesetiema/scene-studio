import { describe, expect, it, vi } from "vitest";
import { parseSceneDocument } from "../../src/core/document/parse";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION } from "../../src/core/document/schema";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const v1Doc = { schemaVersion: 1, sceneId: "scene-1", revision: 0, objects: [] };
const v2Doc = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "scene-1",
  revision: 0,
  objects: [],
  view: createDefaultViewState(),
};

describe("parseSceneDocument", () => {
  it("returns the parsed document on success", () => {
    expect(parseSceneDocument(v2Doc)).toEqual(v2Doc);
  });

  it("migrates a v1 document and reports the step", () => {
    const onMigrate = vi.fn();
    expect(parseSceneDocument(v1Doc, { onMigrate })).toEqual({
      ...v1Doc,
      schemaVersion: 2,
      view: createDefaultViewState(),
    });
    expect(onMigrate).toHaveBeenCalledWith({ from: 1, to: 2 });
  });

  it("does not report a migration for a current document", () => {
    const onMigrate = vi.fn();
    parseSceneDocument(v2Doc, { onMigrate });
    expect(onMigrate).not.toHaveBeenCalled();
  });

  it("throws SceneEditorError with validation code on invalid input", () => {
    try {
      parseSceneDocument({ ...v2Doc, revision: -5 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).detail).toMatchObject({
        issues: expect.any(Array),
      });
    }
  });

  it("surfaces migration errors as validation errors with a reason", () => {
    try {
      parseSceneDocument({ schemaVersion: 99 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).detail).toMatchObject({
        reason: "unsupported-schema-version",
      });
    }
  });
});
