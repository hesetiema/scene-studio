// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { AnimationClipInfo } from "../../src/runtime/runtime-contract";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

const CLIPS: AnimationClipInfo[] = [
  { id: "fox#0", objectId: "fox", index: 0, name: "Survey", duration: 3 },
  { id: "fox#1", objectId: "fox", index: 1, name: "Walk", duration: 2 },
];

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

function lastView(fake: FakeRuntime) {
  return fake.calls.applyViewState.at(-1)!;
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

/* ------------------------------------------------------------------ transport */

describe("element playback transport (model-viewer parity)", () => {
  it("availableAnimations lists clip names once each", async () => {
    const { el, fake } = makeElement();
    fake.clips = [...CLIPS, { ...CLIPS[1]!, id: "prop#1", objectId: "prop" }];
    await connected(el);
    expect(el.availableAnimations).toEqual(["Survey", "Walk"]);
  });

  it("play() starts the first clip and reports through paused/animationName", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);
    expect(el.paused).toBe(true);

    expect(el.play()).toBe(true);
    expect(fake.calls.playAnimation.at(-1)).toEqual({ objectId: null, index: 0 });
    expect(el.paused).toBe(false);
    expect(el.animationName).toBe("Survey");
  });

  it("plays the clip named by animation-name", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    el.setAttribute("animation-name", "walk");
    await connected(el);

    expect(el.play()).toBe(true);
    // Case-insensitive, resolved by the runtime when it can.
    expect(fake.calls.playAnimationByName.at(-1)).toBe("walk");
    expect(el.animationName).toBe("walk");
  });

  it("assigning animationName selects and starts the clip", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);

    el.animationName = "Walk";
    expect(el.getAttribute("animation-name")).toBe("Walk");
    expect(fake.calls.playAnimationByName.at(-1)).toBe("Walk");
    expect(el.paused).toBe(false);
  });

  it("pause() holds the playhead and survives a later autoplay attribute", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);
    el.play();

    el.pause();
    expect(el.paused).toBe(true);
    expect(fake.calls.pauseAnimations).toBe(1);

    // Autoplay arriving after an explicit pause must not restart the mixer.
    el.setAttribute("autoplay", "");
    expect(fake.calls.setAnimationOptions.at(-1)?.autoplay).toBe(false);
  });

  it("play() resumes a paused transport instead of rewind-and-play", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);
    el.play();
    el.pause();
    const starts = fake.calls.playAnimation.length;
    const resumes = fake.calls.resumeAnimations;

    expect(el.play()).toBe(true);
    expect(fake.calls.resumeAnimations).toBe(resumes + 1);
    expect(fake.calls.playAnimation.length).toBe(starts);
  });

  it("play() with no clips is a no-op that reports false", async () => {
    const { el } = makeElement();
    await connected(el);
    expect(el.play()).toBe(false);
    expect(el.availableAnimations).toEqual([]);
  });

  it("currentTime and timeScale proxy the runtime", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);
    el.play();

    el.currentTime = 1.5;
    expect(fake.calls.setAnimationTime.at(-1)).toBe(1.5);
    expect(el.currentTime).toBe(1.5);

    el.timeScale = 0.5;
    expect(fake.calls.setAnimationSpeed.at(-1)).toBe(0.5);
    expect(el.timeScale).toBe(0.5);

    // Garbage is dropped rather than forwarded as NaN.
    el.currentTime = Number.NaN;
    el.timeScale = -1;
    expect(fake.calls.setAnimationTime.at(-1)).toBe(1.5);
    expect(fake.calls.setAnimationSpeed.at(-1)).toBe(0.5);
  });

  it("does not dirty the document when the transport runs", async () => {
    const { el, fake } = makeElement();
    fake.clips = CLIPS;
    await connected(el);
    el.play();
    el.pause();
    expect(el.dirty).toBe(false);
  });
});

/* --------------------------------------------------------------- camera pose */

describe("declarative camera pose (camera-orbit / camera-target / field-of-view)", () => {
  it("spells out theta/phi/radius as a camera position around the target", async () => {
    const { el, fake } = makeElement();
    // Theta 90° → +X, phi 90° → on the horizon.
    el.setAttribute("camera-orbit", "90deg 90deg 10");
    await connected(el);

    const { camera } = lastView(fake);
    expect(camera.position[0]).toBeCloseTo(10, 5);
    expect(camera.position[1]).toBeCloseTo(0, 5);
    expect(camera.position[2]).toBeCloseTo(0, 5);
    expect(camera.target).toEqual([0, 0, 0]);
  });

  it("`auto` keeps the axis it stands for", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    const before = el.getCameraOrbit()!;

    el.setAttribute("camera-orbit", "auto auto 4");
    const after = el.getCameraOrbit()!;
    expect(after.radius).toBeCloseTo(4, 5);
    expect(after.theta).toBeCloseTo(before.theta, 5);
    expect(after.phi).toBeCloseTo(before.phi, 5);
    expect(fake.calls.applyViewState.length).toBeGreaterThan(0);
  });

  it("camera-target moves the eye with the target, keeping the angles", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    const before = el.getCameraOrbit()!;

    el.setAttribute("camera-target", "0 1 0");
    const view = lastView(fake);
    expect(view.camera.target).toEqual([0, 1, 0]);
    const after = el.getCameraOrbit()!;
    expect(after.theta).toBeCloseTo(before.theta, 5);
    expect(after.phi).toBeCloseTo(before.phi, 5);
    expect(after.radius).toBeCloseTo(before.radius, 5);
  });

  it("field-of-view is applied and clamped by min/max-field-of-view", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("max-field-of-view", "45deg");
    el.setAttribute("field-of-view", "90deg");
    await connected(el);
    expect(lastView(fake).camera.fov).toBeCloseTo(45, 5);

    el.setAttribute("min-field-of-view", "20deg");
    el.setAttribute("field-of-view", "5deg");
    expect(lastView(fake).camera.fov).toBeCloseTo(20, 5);
    expect(el.getFieldOfView()).toBeCloseTo(20, 5);
  });

  it("camera-name outranks the orbit attributes", async () => {
    const { el, fake } = makeElement();
    fake.camerasList = ["Front"];
    el.setAttribute("camera-name", "Front");
    el.setAttribute("camera-orbit", "90deg 90deg 10");
    await connected(el);

    expect(fake.calls.setCameraByName).toContain("Front");
    expect(fake.calls.applyViewState).toHaveLength(0);
  });

  it("an unrelated display change does not snap the camera back", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("camera-orbit", "10deg 80deg 8");
    await connected(el);
    const applied = fake.calls.applyViewState.length;

    el.setAttribute("exposure", "1.4");
    expect(fake.calls.applyViewState.length).toBe(applied);

    // A real edit to the orbit attribute still applies.
    el.setAttribute("camera-orbit", "20deg 80deg 8");
    expect(fake.calls.applyViewState.length).toBeGreaterThan(applied);
  });

  it("setCameraOrbit / setCameraTarget / setFieldOfView drive the same pose", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    expect(el.setCameraOrbit({ theta: 0, phi: 90, radius: 6 })).toBe(true);
    let orbit = el.getCameraOrbit()!;
    expect(orbit.theta).toBeCloseTo(0, 5);
    expect(orbit.phi).toBeCloseTo(90, 5);
    expect(orbit.radius).toBeCloseTo(6, 5);

    expect(el.setCameraTarget([1, 2, 3])).toBe(true);
    expect(el.getCameraTarget()).toEqual([1, 2, 3]);
    orbit = el.getCameraOrbit()!;
    expect(orbit.radius).toBeCloseTo(6, 5);

    expect(el.setFieldOfView(35)).toBe(true);
    expect(el.getFieldOfView()).toBeCloseTo(35, 5);
    expect(fake.calls.applyViewState.length).toBeGreaterThan(0);
  });

  it("does not dirty the document", async () => {
    const { el } = makeElement();
    el.setAttribute("camera-orbit", "90deg 90deg 10");
    await connected(el);
    expect(el.dirty).toBe(false);
  });
});

/* ------------------------------------------------------------------- keyboard */

describe("keyboard camera navigation", () => {
  function key(el: SceneEditorElement, name: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: name,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event;
  }

  it("arrows orbit by 5°, shift narrows the step to 1°", async () => {
    const { el } = makeElement();
    await connected(el);
    el.focus();
    const before = el.getCameraOrbit()!;

    const event = key(el, "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expect(el.getCameraOrbit()!.theta).toBeCloseTo(before.theta + 5, 5);

    key(el, "ArrowLeft", true);
    expect(el.getCameraOrbit()!.theta).toBeCloseTo(before.theta + 4, 5);

    key(el, "ArrowDown");
    expect(el.getCameraOrbit()!.phi).toBeCloseTo(before.phi + 5, 5);
  });

  it("+/- dolly by 10%", async () => {
    const { el } = makeElement();
    await connected(el);
    el.focus();
    const before = el.getCameraOrbit()!;

    key(el, "-");
    expect(el.getCameraOrbit()!.radius).toBeCloseTo(before.radius * 1.1, 5);
    key(el, "+");
    expect(el.getCameraOrbit()!.radius).toBeCloseTo(before.radius * 1.1 * 0.9, 5);
  });

  it("stays out of the way when the element is not focused", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    el.blur();
    const applied = fake.calls.applyViewState.length;

    const event = key(el, "ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    expect(fake.calls.applyViewState.length).toBe(applied);
  });

  it("leaves modified keys to the browser and the editor", async () => {
    const { el } = makeElement();
    await connected(el);
    el.focus();
    const before = el.getCameraOrbit()!;

    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(el.getCameraOrbit()!.theta).toBeCloseTo(before.theta, 5);
  });
});

/* ------------------------------------------------------------------------ alt */

describe("alt (accessible label)", () => {
  it("labels the canvas as an image", async () => {
    const { el } = makeElement();
    el.setAttribute("alt", "A fox trotting on the spot");
    await connected(el);

    const canvas = el.querySelector("canvas")!;
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toBe("A fox trotting on the spot");
  });

  it("falls back to the file name, then to nothing", async () => {
    const { el } = makeElement();
    await connected(el);
    const canvas = el.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-label")).toBeNull();

    el.setAttribute("alt", "  ");
    el.setAttribute("src", "assets/models/fox.glb");
    expect(canvas.getAttribute("aria-label")).toBe("3D model: fox.glb");

    el.setAttribute("alt", "Named");
    expect(canvas.getAttribute("aria-label")).toBe("Named");
    el.removeAttribute("alt");
    expect(canvas.getAttribute("aria-label")).toBe("3D model: fox.glb");
  });
});
