import { describe, expect, it } from "vitest";
import { createRenderer } from "../../src/three/create-renderer";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

function fakeCanvas(context: unknown | null): HTMLCanvasElement {
  return {
    getContext: () => context,
    width: 800,
    height: 600,
  } as unknown as HTMLCanvasElement;
}

describe("createRenderer", () => {
  it("throws SceneEditorError with render-init-failed when context is unavailable", () => {
    try {
      createRenderer(fakeCanvas(null));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.RenderInitFailed);
    }
  });
});
