// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

/**
 * `instancing` — the draw-call batching switch.
 *
 * Three separate promises: the flag is *on* by default (so the attribute is
 * never silently the opposite of the default), the factory receives it before
 * the runtime exists, and toggling it later is live — no reload, no document
 * change.
 */

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

function makeElement(): { el: SceneEditorElement; fake: FakeRuntime; options: () => unknown } {
  const fake = new FakeRuntime();
  let captured: unknown;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options;
    return fake;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake, options: () => captured };
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

describe("instancing attribute", () => {
  it("defaults to on and tells the factory before the runtime exists", async () => {
    const { el, options } = makeElement();
    await connected(el);

    expect(el.instancing).toBe(true);
    expect((options() as { instancing?: boolean }).instancing).toBe(true);
  });

  it("reads every spelling a host might write", async () => {
    const { el } = makeElement();
    await connected(el);

    for (const value of ["false", "FALSE", " 0 ", "off", "no"]) {
      el.setAttribute("instancing", value);
      expect(el.instancing, `instancing="${value}"`).toBe(false);
    }
    for (const value of ["true", "1", "", "yes"]) {
      el.setAttribute("instancing", value);
      expect(el.instancing, `instancing="${value}"`).toBe(true);
    }
  });

  it("flips the runtime without reloading", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "model.glb");
    await connected(el);
    const loadsAfterInit = fake.calls.loadDocument.length;

    el.setAttribute("instancing", "false");
    el.removeAttribute("instancing");

    expect(fake.calls.setInstancing).toEqual([true, false, true]);
    expect(fake.calls.loadDocument).toHaveLength(loadsAfterInit);
  });

  it("property setter round-trips through the attribute", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.instancing = false;
    expect(el.getAttribute("instancing")).toBe("false");
    expect(fake.calls.setInstancing.at(-1)).toBe(false);
  });
});
