// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { LIGHTING_PRESETS } from "../../src/core/view/lighting-presets";
import { ViewStateSchema } from "../../src/core/document/schema";
import { createDefaultViewState } from "../../src/core/document/default-view";

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
});

describe("display-mode and explode attributes", () => {
  it("display-mode routes to setDisplayMode", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("display-mode", "xray");
    await connected(el);

    expect(fake.calls.setDisplayMode).toContain("xray");
    expect(fake.displayMode).toBe("xray");
  });

  it("displayMode property mirrors the attribute", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(el.displayMode).toBe("studio");
    el.displayMode = "wireframe";
    expect(el.getAttribute("display-mode")).toBe("wireframe");
    await Promise.resolve();
    expect(fake.calls.setDisplayMode).toContain("wireframe");
    expect(fake.displayMode).toBe("wireframe");
  });

  it("invalid display-mode spellings fall back to studio, not a guess", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("display-mode", "cinematic");
    await connected(el);

    // The attribute apply always routes *something*; "cinematic" must resolve
    // to the identity mode, never a different look.
    expect(fake.calls.setDisplayMode.every((mode) => mode === "studio")).toBe(true);
    expect(el.displayMode).toBe("studio");
  });

  it("explode clamps to 0..1 and routes to setExplode", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("explode", "0.3");
    await connected(el);

    expect(fake.calls.setExplode).toContain(0.3);
    expect(fake.explode).toBe(0.3);

    el.explode = 4;
    expect(el.getAttribute("explode")).toBe("1");
    expect(fake.calls.setExplode).toContain(1);
    expect(el.explode).toBe(1);
  });

  it("absent explode reads as 0, invalid text as 0", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(el.explode).toBe(0);
    el.setAttribute("explode", "lots");
    expect(el.explode).toBe(0);
    expect(fake.calls.setExplode.every((value) => value === 0)).toBe(true);
  });
});

describe("LIGHTING_PRESETS", () => {
  it("every preset parses against the document lights schema", () => {
    const base = createDefaultViewState();
    for (const [id, preset] of Object.entries(LIGHTING_PRESETS)) {
      const view = {
        ...base,
        lights: {
          ...base.lights,
          ambient: preset.ambient,
          directional: preset.directional,
        },
      };
      const parsed = ViewStateSchema.safeParse(view);
      expect(parsed.success, `preset "${id}" must match view.lights`).toBe(true);
    }
  });

  it("has the four reference looks", () => {
    expect(Object.keys(LIGHTING_PRESETS).sort()).toEqual([
      "contrast",
      "cyber",
      "studio",
      "sunset",
    ]);
  });
});
