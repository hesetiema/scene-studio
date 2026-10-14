import { describe, expect, it } from "vitest";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

describe("SceneErrorCode", () => {
  it("exposes stable string codes", () => {
    expect(SceneErrorCode.Validation).toBe("validation");
    expect(SceneErrorCode.AssetResolveFailed).toBe("asset-resolve-failed");
    expect(SceneErrorCode.AssetLoadFailed).toBe("asset-load-failed");
    expect(SceneErrorCode.RenderInitFailed).toBe("render-init-failed");
    expect(SceneErrorCode.Lifecycle).toBe("lifecycle");
    expect(SceneErrorCode.Conflict).toBe("conflict");
  });
});

describe("SceneEditorError", () => {
  it("carries code, message and optional cause/detail", () => {
    const cause = new Error("root");
    const err = new SceneEditorError(SceneErrorCode.Validation, "bad doc", {
      cause,
      detail: { field: "objects[0].id" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SceneEditorError");
    expect(err.code).toBe(SceneErrorCode.Validation);
    expect(err.message).toBe("bad doc");
    expect(err.cause).toBe(cause);
    expect(err.detail).toEqual({ field: "objects[0].id" });
  });

  it("works without optional fields", () => {
    const err = new SceneEditorError(SceneErrorCode.Lifecycle, "disconnected");
    expect(err.detail).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});
