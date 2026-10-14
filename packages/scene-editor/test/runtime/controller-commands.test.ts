import { describe, expect, it, vi } from "vitest";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { TransformCommand } from "../../src/core/commands/transform-command";
import type { SceneDocument } from "../../src/core/document/schema";
import type { Transform } from "../../src/runtime/runtime-contract";

const emptyDoc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "s1",
  revision: 0,
  objects: [],
};

const from: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const to: Transform = {
  position: [5, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("EditorController command integration", () => {
  it("executeCommand applies through the command and records history", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    const cmd = new TransformCommand("obj-1", from, to, (id, t) =>
      fake.applyTransform(id, t),
    );
    controller.executeCommand(cmd);
    expect(fake.calls.applyTransform).toHaveLength(1);
    expect(controller.canUndo).toBe(true);
  });

  it("undo/redo re-apply via runtime and stay in sync", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    controller.executeCommand(
      new TransformCommand("obj-1", from, to, (id, t) => fake.applyTransform(id, t)),
    );
    controller.undo();
    expect(fake.calls.applyTransform[1]?.transform).toBe(from);
    controller.redo();
    expect(fake.calls.applyTransform[2]?.transform).toBe(to);
  });

  it("broadcasts history-change on the runtime event bus (D18)", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    const seen: unknown[] = [];
    fake.events.on("history-change", (payload) => seen.push(payload));
    controller.executeCommand(
      new TransformCommand("obj-1", from, to, () => {}),
    );
    expect(seen).toEqual([
      { canUndo: true, canRedo: false, dirty: true, lastCommand: "transform" },
    ]);
  });

  it("loadDocument clears history and marks clean", async () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    controller.executeCommand(
      new TransformCommand("obj-1", from, to, () => {}),
    );
    await controller.loadDocument(emptyDoc);
    expect(fake.calls.loadDocument).toEqual([emptyDoc]);
    expect(controller.canUndo).toBe(false);
    expect(controller.dirty).toBe(false);
  });

  it("markClean after save clears dirty but keeps undo stack", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    controller.executeCommand(
      new TransformCommand("obj-1", from, to, () => {}),
    );
    controller.markClean();
    expect(controller.dirty).toBe(false);
    expect(controller.canUndo).toBe(true);
  });
});
