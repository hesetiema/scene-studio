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

describe("facade view state (D22)", () => {
  it("forwards interaction view changes with source=interaction", async () => {
    const { runtime, editor } = await setup();
    const seen: Array<{ source: string; fov: number }> = [];
    editor.on("view-change", ({ view, source }) => seen.push({ source, fov: view.camera.fov }));
    const view = createDefaultViewState();
    view.camera.fov = 21;
    runtime.simulateViewChange(view);
    expect(seen).toEqual([{ source: "interaction", fov: 21 }]);
    expect(editor.dirty).toBe(true);
  });

  it("emits source=api for an explicit setViewState", async () => {
    const { editor } = await setup();
    const sources: string[] = [];
    editor.on("view-change", ({ source }) => sources.push(source));
    const view = createDefaultViewState();
    view.camera.fov = 22;
    editor.setViewState(view);
    expect(sources).toEqual(["api"]);
    expect(editor.getDocument().view.camera.fov).toBe(22);
    expect(editor.dirty).toBe(true);
  });

  it("emits source=load when a new scene applies the documented view", async () => {
    const { editor } = await setup();
    const seen: Array<{ source: string; fov: number }> = [];
    editor.on("view-change", ({ view, source }) => seen.push({ source, fov: view.camera.fov }));
    const next = sceneDocument({ sceneId: "b" });
    next.view.camera.fov = 33;
    await editor.loadDocument(next);
    expect(seen).toEqual([{ source: "load", fov: 33 }]);
  });

  it("does not emit source=load for the same scene", async () => {
    const { editor } = await setup();
    const sources: string[] = [];
    editor.on("view-change", ({ source }) => sources.push(source));
    await editor.loadDocument(sceneDocument({ sceneId: "a" }));
    expect(sources).toEqual([]);
  });

  it("exposes the runtime view through getViewState", async () => {
    const { runtime, editor } = await setup();
    const view = createDefaultViewState();
    view.camera.fov = 7;
    runtime.simulateViewChange(view);
    expect(editor.getViewState().camera.fov).toBe(7);
  });

  it("does not emit a view-change for applyRemote on the same scene", async () => {
    const { editor } = await setup();
    const sources: string[] = [];
    editor.on("view-change", ({ source }) => sources.push(source));
    await editor.applyRemote(sceneDocument({ sceneId: "a", revision: 1 }), { baseRevision: 0 });
    expect(sources).toEqual([]);
  });

  it("rejects view calls after destroy", async () => {
    const { editor } = await setup();
    editor.destroy();
    expect(() => editor.getViewState()).toThrow();
  });
});
