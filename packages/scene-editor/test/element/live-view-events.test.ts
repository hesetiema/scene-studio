// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { sceneDocument } from "../support/documents";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

function makeElement(): { el: SceneEditorElement; fake: FakeRuntime } {
  const fake = new FakeRuntime();
  SceneEditorElement.runtimeFactory = () => fake;
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

describe("view-changing opt-in (`live-view-events`)", () => {
  it("is off by default", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    expect(fake.liveViewEvents).toBe(false);
  });

  it("turns on when the attribute is present before upgrade", async () => {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    document.body.innerHTML = `<scene-editor live-view-events></scene-editor>`;
    const el = document.querySelector("scene-editor") as SceneEditorElement;
    await el.ready;
    expect(fake.liveViewEvents).toBe(true);
  });

  it("toggles the runtime sampler on attribute changes", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.setAttribute("live-view-events", "");
    expect(fake.liveViewEvents).toBe(true);

    el.removeAttribute("live-view-events");
    expect(fake.liveViewEvents).toBe(false);
  });

  it("bridges view-changing to a DOM CustomEvent", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s1" }));
    el.setAttribute("live-view-events", "");

    const seen: number[] = [];
    el.addEventListener("view-changing", (event) => {
      seen.push(event.detail.view.camera.fov);
    });

    const view = createDefaultViewState();
    view.camera.fov = 24;
    fake.simulateViewChanging(view);

    expect(seen).toEqual([24]);
  });

  it("delivers nothing while live sampling is off", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s1" }));

    const spy = vi.fn();
    el.addEventListener("view-changing", spy);

    const view = createDefaultViewState();
    view.camera.fov = 24;
    fake.simulateViewChanging(view);

    expect(spy).not.toHaveBeenCalled();
  });
});
