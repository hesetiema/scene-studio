// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement, type RuntimeFactoryOptions } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

let captured: RuntimeFactoryOptions | undefined;

function makeElement(): { el: SceneEditorElement; fake: FakeRuntime } {
  const fake = new FakeRuntime();
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options;
    return fake;
  };
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
  captured = undefined;
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

describe("with-credentials", () => {
  it("is off by default", async () => {
    const { el } = makeElement();
    await connected(el);

    expect(captured?.getWithCredentials?.()).toBe(false);
  });

  it("reflects the attribute at read time, not at construction", async () => {
    const { el } = makeElement();
    await connected(el);

    // The loader reads this right before each fetch, so flipping the attribute
    // after connect is enough for the next load.
    el.setAttribute("with-credentials", "");
    expect(captured?.getWithCredentials?.()).toBe(true);

    el.removeAttribute("with-credentials");
    expect(captured?.getWithCredentials?.()).toBe(false);
  });
});
