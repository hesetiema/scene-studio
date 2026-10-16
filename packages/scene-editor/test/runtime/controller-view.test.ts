import { describe, expect, it } from "vitest";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { sceneDocument } from "../support/documents";
import { SceneEditorError } from "../../src/core/events/errors";

async function setup(doc = sceneDocument()) {
  const runtime = new FakeRuntime();
  const controller = new EditorController(runtime);
  await controller.loadDocument(doc);
  return { runtime, controller };
}

describe("EditorController view state (D22)", () => {
  it("applies the documented view when the scene changes", async () => {
    const doc = sceneDocument({ sceneId: "a", view: createDefaultViewState() });
    doc.view.camera.fov = 40;
    const { runtime } = await setup(doc);
    expect(runtime.calls.applyViewState).toHaveLength(1);
    expect(runtime.calls.applyViewState[0]?.camera.fov).toBe(40);
  });

  it("does not re-apply the view for the same scene, nor for applyRemote on the same scene", async () => {
    const { runtime, controller } = await setup(sceneDocument({ sceneId: "a", revision: 0 }));
    expect(runtime.calls.applyViewState).toHaveLength(1);

    await controller.applyRemote(
      sceneDocument({ sceneId: "a", revision: 1 }),
      { baseRevision: 0 },
    );
    expect(runtime.calls.applyViewState).toHaveLength(1);
  });

  it("applies the view when applyRemote switches scenes", async () => {
    const { runtime, controller } = await setup(sceneDocument({ sceneId: "a", revision: 0 }));
    await controller.applyRemote(sceneDocument({ sceneId: "b", revision: 1 }), {
      baseRevision: 0,
    });
    expect(runtime.calls.applyViewState).toHaveLength(2);
  });

  it("marks dirty on a runtime interaction without entering the undo stack", async () => {
    const { runtime, controller } = await setup();
    expect(controller.dirty).toBe(false);
    const view = createDefaultViewState();
    view.camera.fov = 12;
    runtime.simulateViewChange(view);
    expect(controller.dirty).toBe(true);
    expect(controller.canUndo).toBe(false);
    expect(controller.getDocument().view.camera.fov).toBe(12);
  });

  it("marks dirty on setViewState and forwards it to the runtime", async () => {
    const { runtime, controller } = await setup();
    const view = createDefaultViewState();
    view.environment.gridVisible = false;
    controller.setViewState(view);
    expect(controller.dirty).toBe(true);
    expect(controller.canUndo).toBe(false);
    expect(runtime.calls.applyViewState.at(-1)).toEqual(view);
    expect(controller.getDocument().view.environment.gridVisible).toBe(false);
  });

  it("clears the view dirty flag on markSaved", async () => {
    const { runtime, controller } = await setup();
    const view = createDefaultViewState();
    view.camera.fov = 50;
    runtime.simulateViewChange(view);
    expect(controller.dirty).toBe(true);
    controller.markSaved(1);
    expect(controller.dirty).toBe(false);
  });

  it("clears the view dirty flag when a document is (re)loaded", async () => {
    const { runtime, controller } = await setup();
    const view = createDefaultViewState();
    view.camera.fov = 50;
    runtime.simulateViewChange(view);
    expect(controller.dirty).toBe(true);
    await controller.loadDocument(sceneDocument());
    expect(controller.dirty).toBe(false);
  });

  it("exposes the scene id and the live view", async () => {
    const { runtime, controller } = await setup(sceneDocument({ sceneId: "live" }));
    expect(controller.getSceneId()).toBe("live");
    const view = createDefaultViewState();
    view.camera.fov = 3;
    runtime.simulateViewChange(view);
    expect(controller.getViewState().camera.fov).toBe(3);
  });

  it("throws a lifecycle error when setting a view with no document", () => {
    const controller = new EditorController(new FakeRuntime());
    expect(() => controller.setViewState(createDefaultViewState())).toThrow(SceneEditorError);
  });

  it("ignores a runtime view change before any document is loaded", () => {
    const controller = new EditorController(new FakeRuntime());
    expect(() => controller.handleRuntimeViewChange(createDefaultViewState())).not.toThrow();
  });
});
