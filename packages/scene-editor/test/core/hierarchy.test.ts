import { describe, expect, it } from "vitest";
import { validateHierarchy } from "../../src/core/document/hierarchy";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import type { SceneObjectDTO } from "../../src/core/document/schema";

function obj(id: string, parentId?: string): SceneObjectDTO {
  return {
    id,
    type: "mesh",
    name: id,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

describe("validateHierarchy", () => {
  it("accepts flat and valid parent chains", () => {
    expect(() =>
      validateHierarchy([obj("a"), obj("b"), obj("c", "a")]),
    ).not.toThrow();
  });

  it("rejects parentId pointing at a missing object", () => {
    try {
      validateHierarchy([obj("a", "ghost")]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).message).toMatch(/parentId/);
    }
  });

  it("rejects self-parenting", () => {
    expect(() => validateHierarchy([obj("a", "a")])).toThrow(/parentId/);
  });

  it("rejects cycles (a→b→a)", () => {
    expect(() =>
      validateHierarchy([obj("a", "b"), obj("b", "a")]),
    ).toThrow(/cycle|环/);
  });

  it("rejects duplicate object ids", () => {
    expect(() => validateHierarchy([obj("a"), obj("a")])).toThrow(/[Dd]uplicate|重复/);
  });

  it("accepts deep valid trees", () => {
    expect(() =>
      validateHierarchy([obj("root"), obj("mid", "root"), obj("leaf", "mid")]),
    ).not.toThrow();
  });
});
