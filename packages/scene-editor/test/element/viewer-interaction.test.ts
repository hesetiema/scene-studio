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

function canvasOf(el: SceneEditorElement): HTMLCanvasElement {
  const canvas = el.querySelector("canvas");
  if (!canvas) throw new Error("canvas missing");
  return canvas;
}

function lastControls(fake: FakeRuntime) {
  return fake.calls.setCameraControls.at(-1)!;
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

describe("touch-action", () => {
  it("defaults to model-viewer's pan-y", async () => {
    const { el } = makeElement();
    await connected(el);

    expect(canvasOf(el).style.touchAction).toBe("pan-y");
  });

  it("accepts the three documented keywords, case and whitespace included", async () => {
    const { el } = makeElement();
    el.setAttribute("touch-action", "  None ");
    await connected(el);

    expect(canvasOf(el).style.touchAction).toBe("none");
  });

  it("falls back to pan-y for auto and for anything unrecognised", async () => {
    const { el } = makeElement();
    // `auto` is deliberately not allowed: it is what lets the canvas swallow
    // vertical scrolls, i.e. exactly the hijack this attribute exists to stop.
    el.setAttribute("touch-action", "auto");
    await connected(el);
    expect(canvasOf(el).style.touchAction).toBe("pan-y");

    el.setAttribute("touch-action", "pinch-zoom");
    expect(canvasOf(el).style.touchAction).toBe("pan-y");
  });

  it("re-applies when the attribute changes after connect", async () => {
    const { el } = makeElement();
    await connected(el);

    el.setAttribute("touch-action", "none");
    expect(canvasOf(el).style.touchAction).toBe("none");

    el.removeAttribute("touch-action");
    expect(canvasOf(el).style.touchAction).toBe("pan-y");
  });
});

describe("orbit-sensitivity", () => {
  it("defaults to 1 and rides along with the other camera controls", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(lastControls(fake)).toMatchObject({ pan: true, zoom: true, sensitivity: 1 });
  });

  it("forwards fractions, zero and negatives unchanged", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("orbit-sensitivity", "0.25");
    await connected(el);
    expect(lastControls(fake).sensitivity).toBe(0.25);

    el.setAttribute("orbit-sensitivity", "0");
    expect(lastControls(fake).sensitivity).toBe(0);
    // Negative inverts the drag; it must survive the parse, not be clamped.
    el.setAttribute("orbit-sensitivity", "-1.5");
    expect(lastControls(fake).sensitivity).toBe(-1.5);
  });

  it("falls back to 1 rather than freezing on a garbage value", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("orbit-sensitivity", "fast");
    await connected(el);

    expect(lastControls(fake).sensitivity).toBe(1);
  });
});

describe("zoom-sensitivity / pan-sensitivity", () => {
  it("defaults both to 1", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(lastControls(fake)).toMatchObject({ zoomSensitivity: 1, panSensitivity: 1 });
  });

  it("forwards each verb independently, zero included", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("zoom-sensitivity", "0.5");
    await connected(el);
    expect(lastControls(fake)).toMatchObject({ zoomSensitivity: 0.5, panSensitivity: 1 });

    // Freezing the wheel while the drag still orbits is the whole point of
    // `0`, so it must not be read as "unset".
    el.setAttribute("zoom-sensitivity", "0");
    expect(lastControls(fake).zoomSensitivity).toBe(0);

    el.setAttribute("pan-sensitivity", "2");
    expect(lastControls(fake)).toMatchObject({ zoomSensitivity: 0, panSensitivity: 2 });
  });
});

describe("resetTurntableRotation", () => {
  it("asks the runtime and reports success", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(el.resetTurntableRotation()).toBe(true);
    expect(fake.calls.resetTurntableRotation).toBe(1);
  });
});
