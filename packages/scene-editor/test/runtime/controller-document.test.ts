import { describe, expect, it } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { SceneDocument } from "../../src/core/document/schema";
import type { Transform } from "../../src/runtime/runtime-contract";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const doc: SceneDocument = {
  schemaVersion: 2,
  view: createDefaultViewState(),
  sceneId: "s1",
  revision: 0,
  objects: [
    {
      id: "box-1",
      type: "mesh",
      name: "Box",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

const from: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const to: Transform = {
  position: [3, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("EditorController document state (D18 getDocument snapshot)", () => {
  it("getDocument throws lifecycle error before any load", () => {
    const controller = new EditorController(new FakeRuntime());
    try {
      controller.getDocument();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Lifecycle);
    }
  });

  it("applyTransform updates runtime and the stored document; undo restores both", async () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    await controller.loadDocument(doc);
    controller.applyTransform("box-1", from, to);
    expect(controller.getDocument().objects[0]?.position).toEqual([3, 0, 0]);
    expect(fake.calls.applyTransform[0]?.transform).toBe(to);
    controller.undo();
    expect(controller.getDocument().objects[0]?.position).toEqual([0, 0, 0]);
    expect(fake.calls.applyTransform[1]?.transform).toBe(from);
  });

  it("getDocument returns a detached snapshot (mutations do not leak)", async () => {
    const controller = new EditorController(new FakeRuntime());
    await controller.loadDocument(doc);
    const snap = controller.getDocument();
    (snap.objects[0] as { name: string }).name = "mutated";
    expect(controller.getDocument().objects[0]?.name).toBe("Box");
  });
});
