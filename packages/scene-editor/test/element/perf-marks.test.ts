// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

beforeAll(() => {
  defineSceneEditor();
});

const doc: SceneDocument = {
  schemaVersion: SCHEMA_VERSION,
  view: createDefaultViewState(),
  sceneId: "s1",
  revision: 0,
  objects: [],
};

describe("baseline performance marks (D10)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = () => new FakeRuntime();
  });

  it("loadDocument emits scene-editor:load start/end marks", async () => {
    const el = document.createElement("scene-editor") as SceneEditorElement;
    document.body.appendChild(el);
    await el.ready;
    await el.loadDocument(doc);
    const entries = performance.getEntriesByName("scene-editor:load", "measure");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.duration).toBeGreaterThanOrEqual(0);
  });
});
