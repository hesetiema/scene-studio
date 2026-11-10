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

describe("camera pose transitions", () => {
  it("places the first pose instantly, with no fade on load", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("camera-orbit", "45deg 60deg 4");
    await connected(el);

    expect(fake.calls.applyViewState.length).toBeGreaterThan(0);
    expect(fake.calls.smoothViewTo).toHaveLength(0);
  });

  it("fades a later camera-orbit change over the default decay", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("camera-orbit", "0deg 75deg 4");
    await connected(el);
    fake.calls.applyViewState.length = 0;

    el.setAttribute("camera-orbit", "90deg 75deg 4");

    expect(fake.calls.smoothViewTo).toHaveLength(1);
    expect(fake.calls.smoothViewTo[0]!.decayMs).toBe(50);
    // The goal is the new orbit, not the old one.
    const [x, , z] = fake.calls.smoothViewTo[0]!.view.position;
    expect(x).toBeGreaterThan(0.1);
    expect(z).toBeLessThan(0.1);
  });

  it("honours interpolation-decay", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("camera-orbit", "0deg 75deg 4");
    await connected(el);

    el.setAttribute("interpolation-decay", "200");
    el.setAttribute("camera-orbit", "30deg 75deg 4");

    expect(fake.calls.smoothViewTo.at(-1)!.decayMs).toBe(200);
  });

  it("falls back to the default for a broken interpolation-decay", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("camera-orbit", "0deg 75deg 4");
    await connected(el);

    el.setAttribute("interpolation-decay", "fast");
    el.setAttribute("camera-orbit", "30deg 75deg 4");

    expect(fake.calls.smoothViewTo.at(-1)!.decayMs).toBe(50);
  });

  it("fades API-driven pose writes too, not just attributes", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    // `setFieldOfView()` is a host intent like the attribute is: it fades.
    expect(el.setFieldOfView(35)).toBe(true);
    expect(fake.calls.smoothViewTo.at(-1)!.view.fov).toBe(35);

    el.setFieldOfView(50);
    expect(fake.calls.smoothViewTo.at(-1)!.view.fov).toBe(50);
  });
});

describe("jumpCameraToGoal", () => {
  it("asks the runtime to land immediately", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(el.jumpCameraToGoal()).toBe(true);
    expect(fake.calls.jumpCameraToGoal).toBe(1);
  });
});

describe("resetTurntableRotation", () => {
  it("passes an explicit theta through", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.resetTurntableRotation();
    expect(fake.calls.resetTurntableThetas.at(-1)).toBe(0);
  });
});
