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
