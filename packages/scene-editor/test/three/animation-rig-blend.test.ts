// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createAnimationRig } from "../../src/three/viewer/animation-rig";

function clip(axis: "x" | "y", name: string, duration = 1): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(`.position[${axis}]`, [0, duration], [0, 10]),
  ]);
}

function setup() {
  const rig = createAnimationRig();
  const root = new THREE.Group();
  rig.register("box-1", root, [clip("x", "Walk"), clip("y", "Wave")]);
  return { rig, root };
}

describe("AnimationRig blends", () => {
  it("plays two clips at once with normalized weights", () => {
    const { rig, root } = setup();

    expect(rig.playBlend("box-1", [{ index: 0, weight: 1 }, { index: 1, weight: 1 }])).toBe(true);
    expect(rig.playing).toBe(true);
    expect(rig.blend.map((layer) => layer.weight)).toEqual([0.5, 0.5]);

    rig.update(0.5);

    // Each clip is at 5 on its own axis, halved by its share.
    expect(root.position.x).toBeCloseTo(2.5, 5);
    expect(root.position.y).toBeCloseTo(2.5, 5);
  });

  it("honours an uneven split", () => {
    const { rig, root } = setup();

    rig.playBlend("box-1", [{ index: 0, weight: 3 }, { index: 1, weight: 1 }]);
    rig.update(0.5);

    expect(root.position.x).toBeCloseTo(3.75, 5);
    expect(root.position.y).toBeCloseTo(1.25, 5);
  });

  it("falls back to play() for a single layer", () => {
    const { rig } = setup();

    rig.playBlend("box-1", [{ index: 0, weight: 0.3 }]);

    expect(rig.blend).toEqual([{ index: 0, name: "Walk", weight: 1, timeScale: 1 }]);
    expect(rig.duration).toBe(1);
  });

  it("reports the union of driven channels", () => {
    const { rig } = setup();
    rig.playBlend("box-1", [{ index: 0, weight: 1 }, { index: 1, weight: 1 }]);

    expect(rig.activeTrackNames().sort()).toEqual([".position[x]", ".position[y]"]);
    rig.pause();
    expect(rig.activeTrackNames()).toEqual([]);
  });

  it("pauses, resumes and scrubs every layer", () => {
    const { rig, root } = setup();
    rig.playBlend("box-1", [{ index: 0, weight: 1 }, { index: 1, weight: 1 }]);

    rig.pause();
    rig.update(0.5);
    expect(root.position.x).toBeCloseTo(0, 5);

    rig.resume();
    rig.update(0.5);
    expect(root.position.x).toBeCloseTo(2.5, 5);

    rig.setTime(0.2);
    expect(root.position.x).toBeCloseTo(1, 5);
    expect(root.position.y).toBeCloseTo(1, 5);
  });

  it("keeps per-layer time scales independent", () => {
    const { rig, root } = setup();
    rig.playBlend("box-1", [
      { index: 0, weight: 1 },
      { index: 1, weight: 1, timeScale: 0 },
    ]);

    rig.update(0.5);

    expect(root.position.x).toBeCloseTo(2.5, 5);
    // A frozen layer holds its first frame, weighted at half.
    expect(root.position.y).toBeCloseTo(0, 5);
  });

  it("rejects an empty or unknown blend", () => {
    const { rig } = setup();

    expect(rig.playBlend("box-1", [])).toBe(false);
    expect(rig.playBlend("box-1", [{ index: 9, weight: 1 }])).toBe(false);
    expect(rig.playBlend("missing", [{ index: 0, weight: 1 }])).toBe(false);
    expect(rig.playing).toBe(false);
  });

  it("drops the extra layers when a single clip is started", () => {
    const { rig, root } = setup();
    rig.playBlend("box-1", [{ index: 0, weight: 1 }, { index: 1, weight: 1 }]);

    rig.play("box-1", 1);
    rig.update(0.5);

    expect(rig.blend).toHaveLength(1);
    expect(rig.blend[0]!.index).toBe(1);
    // The stopped layer no longer writes its channel; the new one is at full weight.
    expect(root.position.y).toBeCloseTo(5, 5);
  });

  it("stops the whole blend on dispose", () => {
    const { rig } = setup();
    rig.playBlend("box-1", [{ index: 0, weight: 1 }, { index: 1, weight: 1 }]);

    rig.dispose();

    expect(rig.blend).toEqual([]);
    expect(rig.playing).toBe(false);
    expect(rig.update(0.5)).toBe(false);
  });
});
