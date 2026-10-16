// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { SceneDocument } from "../../src/core/document/schema";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

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
    {
      id: "box-2",
      type: "mesh",
      name: "Box2",
      position: [2, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

describe("SceneEditorElement viewport interaction", () => {
  beforeAll(() => {
    defineSceneEditor();
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  async function setup(): Promise<{ el: SceneEditorElement; fake: FakeRuntime }> {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    document.body.appendChild(el);
    await el.ready;
    await el.loadDocument(doc);
    return { el, fake };
  }

  it("click on canvas picks and selects the hit object", async () => {
    const { el, fake } = await setup();
    fake.pickResult = "box-1";
    const canvas = el.querySelector("canvas")!;
    canvas.dispatchEvent(
      new MouseEvent("click", { clientX: 10, clientY: 20, bubbles: true }),
    );
    expect(fake.calls.pick).toEqual([[10, 20]]);
    expect(fake.calls.select).toContainEqual(["box-1"]);
    expect(el.selectedIds).toEqual(["box-1"]);
  });

  it("click on empty space clears selection", async () => {
    const { el, fake } = await setup();
    el.selectObject("box-1");
    fake.pickResult = null;
    const canvas = el.querySelector("canvas")!;
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5, bubbles: true }));
    expect(fake.calls.clearSelection).toBeGreaterThanOrEqual(1);
  });

  it("emits selection-change when runtime reports selection", async () => {
    const { el, fake } = await setup();
    const spy = vi.fn();
    el.addEventListener("selection-change", spy);
    fake.events.emit("selection-change", { ids: ["box-2"] });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { ids: ["box-2"] } }),
    );
  });
});
