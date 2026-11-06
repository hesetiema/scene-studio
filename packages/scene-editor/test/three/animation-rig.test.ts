// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createAnimationRig } from "../../src/three/viewer/animation-rig";

function makeClip(name = "Slide"): THREE.AnimationClip {
  return new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack(".position[x]", [0, 1], [0, 1]),
  ]);
}

describe("AnimationRig (viewer split)", () => {
  it("registers glTF clips and lists stable ids", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [makeClip("Slide"), { not: "a clip" }]);

    expect(rig.list()).toEqual([
      { id: "box-1#0", objectId: "box-1", index: 0, name: "Slide", duration: 1 },
    ]);
    expect(rig.playing).toBe(false);
  });

  it("plays one clip, advances the mixer and pauses", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [makeClip()]);

    expect(rig.play("box-1")).toBe(true);
    expect(rig.playing).toBe(true);
    expect(rig.update(0.5)).toBe(true);
    expect(root.position.x).toBeCloseTo(0.5, 5);

    rig.pause();
    expect(rig.playing).toBe(false);
    expect(rig.update(0.5)).toBe(false);
  });

  it("applies playback speed and scrubs by time", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [makeClip()]);

    rig.setSpeed(2);
    rig.play("box-1");
    rig.update(0.25);
    expect(root.position.x).toBeCloseTo(0.5, 5);

    rig.setTime(0.25);
    expect(root.position.x).toBeCloseTo(0.25, 5);
  });

  it("rejects unknown objects / indices and forgets disposed tracks", () => {
    const rig = createAnimationRig();
    rig.register("box-1", new THREE.Group(), [makeClip()]);

    expect(rig.play("missing")).toBe(false);
    expect(rig.play("box-1", 9)).toBe(false);

    rig.dispose();
    expect(rig.list()).toEqual([]);
    expect(rig.play(null)).toBe(false);
  });
});

function clipOn(axis: "x" | "y", name: string, duration = 1): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(`.position[${axis}]`, [0, duration], [0, 10]),
  ]);
}

describe("AnimationRig transport (model-viewer parity)", () => {
  it("matches a clip by name, case-insensitively", () => {
    const rig = createAnimationRig();
    rig.register("box-1", new THREE.Group(), [clipOn("x", "Idle"), clipOn("y", "Wave")]);

    expect(rig.playByName("  wave ")).toBe(true);
    expect(rig.playing).toBe(true);
    // Unknown names stay non-destructive: the active clip keeps playing.
    expect(rig.playByName("missing")).toBe(false);
    expect(rig.playing).toBe(true);
  });

  it("switches clips on one object without dropping playback", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [clipOn("x", "Idle"), clipOn("y", "Wave")]);

    rig.setOptions({ crossfadeSeconds: 0.2 });
    rig.play("box-1", 0);
    rig.update(0.5);
    expect(root.position.x).toBeCloseTo(5, 5);

    // The crossfade schedules a fade instead of stopping the old action.
    expect(rig.play("box-1", 1)).toBe(true);
    expect(rig.playing).toBe(true);
    rig.update(0.5);

    // The incoming clip owns its own track from the first update onwards.
    expect(root.position.y).toBeGreaterThan(0);
  });

  it("ignores a non-finite crossfade duration", () => {
    const rig = createAnimationRig();
    rig.register("box-1", new THREE.Group(), [clipOn("x", "One")]);

    rig.setOptions({ crossfadeSeconds: Number.NaN });
    expect(rig.play("box-1")).toBe(true);
    expect(rig.update(0.5)).toBe(true);
  });

  it("pause-at-end holds the last frame and reports playback stopped", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [clipOn("x", "Once")]);

    rig.setOptions({ pauseAtEnd: true });
    rig.play("box-1");
    // Past the 1 s clip: the mixer fires `finished` inside update().
    expect(rig.update(1.2)).toBe(false);
    expect(rig.playing).toBe(false);
    expect(root.position.x).toBeCloseTo(10, 5);

    // Nothing advances while clamped…
    expect(rig.update(1)).toBe(false);
    expect(root.position.x).toBeCloseTo(10, 5);

    // …and resume rewinds instead of sitting on the last frame.
    expect(rig.resume()).toBe(true);
    rig.update(0.5);
    expect(root.position.x).toBeCloseTo(5, 5);
  });

  it("loops by default", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [clipOn("x", "Loop")]);

    rig.play("box-1");
    expect(rig.update(1.2)).toBe(true);
    expect(rig.playing).toBe(true);
    expect(root.position.x).toBeCloseTo(2, 5);
  });

  it("applies a policy change to the clip already playing", () => {
    const rig = createAnimationRig();
    const root = new THREE.Group();
    rig.register("box-1", root, [clipOn("x", "Once")]);

    rig.play("box-1");
    rig.setOptions({ pauseAtEnd: true });
    expect(rig.update(1.2)).toBe(false);
    expect(root.position.x).toBeCloseTo(10, 5);
  });
});
