import { describe, expect, it } from "vitest";
import { createSceneEditor } from "../../src/runtime/create-scene-editor";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { sceneDocument } from "../support/documents";

async function setup() {
  const runtime = new FakeRuntime();
  const editor = createSceneEditor({ runtime });
  await editor.loadDocument(sceneDocument({ sceneId: "a" }));
  return { runtime, editor };
}

describe("facade view-changing forwarding (D22)", () => {
  it("forwards in-flight samples verbatim when the runtime emits them", async () => {
    const { runtime, editor } = await setup();
    const seen: number[] = [];
    editor.on("view-changing", ({ view }) => seen.push(view.camera.fov));

    runtime.setLiveViewEvents(true);
    const view = createDefaultViewState();
    view.camera.fov = 27;
    runtime.simulateViewChanging(view);

    expect(seen).toEqual([27]);
  });

  it("never invents a sample while the runtime is opted out", async () => {
    const { runtime, editor } = await setup();
    const seen: number[] = [];
    editor.on("view-changing", ({ view }) => seen.push(view.camera.fov));

    const view = createDefaultViewState();
    view.camera.fov = 27;
    runtime.simulateViewChanging(view);

    expect(seen).toEqual([]);
  });

  it("does not mark the document dirty — high-frequency, never a command", async () => {
    const { runtime, editor } = await setup();
    runtime.setLiveViewEvents(true);
    const view = createDefaultViewState();
    view.camera.fov = 27;
    runtime.simulateViewChanging(view);

    expect(editor.dirty).toBe(false);
  });
});
