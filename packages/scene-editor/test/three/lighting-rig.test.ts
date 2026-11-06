import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createLightingRig } from "../../src/three/viewer/lighting-rig";
import { createDefaultViewState } from "../../src/core/document/default-view";
import type { AdditionalLightDTO } from "../../src/core/document/schema";

function build(additional?: AdditionalLightDTO[]) {
  const scene = new THREE.Scene();
  const view = createDefaultViewState();
  if (additional !== undefined) view.lights.additional = additional;
  const rig = createLightingRig(scene, view.lights);
  return { scene, rig, view };
}

describe("lighting rig: fixed slots", () => {
  it("mounts ambient + directional and hides the empty extras list", () => {
    const { scene, rig, view } = build();

    expect(scene.children).toHaveLength(2);
    expect(rig.lights).toHaveLength(2);
    // Round-trips to exactly the created view: no `additional: []` noise.
    expect(rig.readView()).toEqual(view.lights);

    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe("lighting rig: additional lights", () => {
  const point: AdditionalLightDTO = {
    kind: "point",
    color: "#ff8800",
    intensity: 2,
    position: [1, 2, 3],
    distance: 5,
    decay: 1,
  };

  it("mounts extras on the scene", () => {
    const { scene, rig } = build([point]);

    expect(scene.children).toHaveLength(3);
    expect(rig.lights).toHaveLength(3);
    const light = rig.lights[2] as THREE.PointLight;
    expect(light.isPointLight).toBe(true);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
    expect(light.color.getHexString()).toBe("ff8800");

    rig.dispose();
  });

  it("round-trips every supported kind", () => {
    const additional: AdditionalLightDTO[] = [
      { kind: "directional", color: "#ffffff", intensity: 1, position: [0, 4, 0] },
      point,
      {
        kind: "spot",
        color: "#00ff00",
        intensity: 3,
        position: [2, 5, 2],
        target: [0, 0, 0],
        angle: 0.5,
        penumbra: 0.2,
        distance: 10,
        decay: 2,
      },
      { kind: "hemisphere", skyColor: "#aabbcc", groundColor: "#112233", intensity: 0.4 },
    ];
    const { rig, scene } = build(additional);

    expect(rig.readView().additional).toEqual(additional);

    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("replaces extras on applyView instead of accumulating them", () => {
    const { scene, rig, view } = build([point]);

    rig.applyView({ ...view.lights, additional: [] });
    expect(scene.children).toHaveLength(2);
    expect(rig.lights).toHaveLength(2);

    rig.applyView({ ...view.lights, additional: [point] });
    expect(scene.children).toHaveLength(3);

    rig.dispose();
  });

  it("does not invent a target when the document omitted one", () => {
    const { rig } = build([point]);
    const view = rig.readView();
    expect(view.additional?.[0]).not.toHaveProperty("target");
    rig.dispose();
  });
});
