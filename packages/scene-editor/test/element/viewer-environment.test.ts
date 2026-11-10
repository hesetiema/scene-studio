// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

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

function last<T>(list: T[]): T {
  return list.at(-1)!;
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

describe("environment-image", () => {
  it("treats neutral / room / legacy as presets, not files", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("environment-image", "neutral");
    await connected(el);

    expect(last(fake.calls.setEnvironmentPreset)).toBe("neutral");
    expect(last(fake.calls.setEnvironmentImage)).toBeNull();
  });

  it("maps model-viewer's legacy preset through to the runtime", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("environment-image", "legacy");
    await connected(el);

    expect(last(fake.calls.setEnvironmentPreset)).toBe("legacy");
  });

  it("passes anything else through as a URL for reflections only", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("environment-image", "/assets/studio.hdr");
    await connected(el);

    expect(last(fake.calls.setEnvironmentImage)).toBe("/assets/studio.hdr");
    // A URL must not be mistaken for a preset name.
    expect(last(fake.calls.setEnvironmentPreset)).not.toBe("/assets/studio.hdr");
  });

  it("hands the IBL back when the attribute is removed", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("environment-image", "/assets/studio.hdr");
    await connected(el);

    el.removeAttribute("environment-image");
    expect(last(fake.calls.setEnvironmentImage)).toBeNull();
  });
});

describe("skybox-image", () => {
  it("is a backdrop only when environment-image already owns the IBL", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("environment-image", "/assets/studio.hdr");
    el.setAttribute("skybox-image", "/assets/sky.jpg");
    await connected(el);

    expect(last(fake.calls.setSkyboxImage)).toEqual({
      url: "/assets/sky.jpg",
      asEnvironment: false,
    });
  });

  it("lights the model when it is the only image (model-viewer's rule)", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("skybox-image", "/assets/sky.hdr");
    await connected(el);

    expect(last(fake.calls.setSkyboxImage)).toEqual({
      url: "/assets/sky.hdr",
      asEnvironment: true,
    });
  });

  it("drops the backdrop and re-derives the lighting on removal", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("skybox-image", "/assets/sky.hdr");
    await connected(el);

    el.removeAttribute("skybox-image");
    expect(last(fake.calls.setSkyboxImage)).toEqual({ url: null, asEnvironment: false });
  });
});
