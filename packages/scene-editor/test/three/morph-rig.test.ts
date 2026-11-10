import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createMorphRig } from "../../src/three/viewer/morph-rig";

type MorphMesh = THREE.Mesh & {
  morphTargetInfluences: number[];
  morphTargetDictionary: Record<string, number>;
};

function morphMesh(names: string[], weights: number[] = []): MorphMesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry()) as MorphMesh;
  mesh.morphTargetInfluences = names.map((_, index) => weights[index] ?? 0);
  mesh.morphTargetDictionary = Object.fromEntries(names.map((name, index) => [name, index]));
  return mesh;
}

function rootWith(meshes: THREE.Object3D[], objectId = "obj-1"): THREE.Group {
  const root = new THREE.Group();
  root.userData = { objectId };
  for (const mesh of meshes) root.add(mesh);
  return root;
}

describe("morph rig", () => {
  it("lists channels per mesh with the glTF target names", () => {
    const face = morphMesh(["Smile", "Blink"]);
    face.name = "Face";
    const rig = createMorphRig({
      roots: () => [rootWith([face])],
      activeTrackNames: () => [],
    });

    expect(rig.list()).toEqual([
      {
        objectId: "obj-1",
        meshIndex: 0,
        meshName: "Face",
        targetIndex: 0,
        name: "Smile",
        influence: 0,
        driven: false,
      },
      {
        objectId: "obj-1",
        meshIndex: 0,
        meshName: "Face",
        targetIndex: 1,
        name: "Blink",
        influence: 0,
        driven: false,
      },
    ]);
  });

  it("falls back to positional names and skips non-morph meshes", () => {
    const plain = new THREE.Mesh(new THREE.BoxGeometry());
    const morph = morphMesh(["only"]);
    morph.morphTargetDictionary = null as unknown as Record<string, number>;
    const rig = createMorphRig({
      roots: () => [rootWith([plain, morph])],
      activeTrackNames: () => [],
    });

    const listed = rig.list();
    expect(listed).toHaveLength(1);
    // The plain box is not morph-capable, so it does not consume an index.
    expect(listed[0]?.meshIndex).toBe(0);
    expect(listed[0]?.name).toBe("Target 1");
    expect(listed[0]?.meshName).toBe("");
  });

  it("skips subtrees without a document id", () => {
    const loose = new THREE.Group();
    loose.add(morphMesh(["x"]));
    const rig = createMorphRig({ roots: () => [loose], activeTrackNames: () => [] });
    expect(rig.list()).toEqual([]);
  });

  it("writes a weight, clamped to 0..1", () => {
    const face = morphMesh(["Smile", "Blink"]);
    face.name = "Face";
    const rig = createMorphRig({
      roots: () => [rootWith([face])],
      activeTrackNames: () => [],
    });

    expect(rig.setInfluence("obj-1", 0, 0, 0.4)).toBe(true);
    expect(face.morphTargetInfluences[0]).toBeCloseTo(0.4);

    rig.setInfluence("obj-1", 0, 0, 3);
    expect(face.morphTargetInfluences[0]).toBe(1);
    rig.setInfluence("obj-1", 0, 1, -2);
    expect(face.morphTargetInfluences[1]).toBe(0);
  });

  it("refuses a channel the playing clip drives", () => {
    const face = morphMesh(["Smile"]);
    face.name = "Face";
    const rig = createMorphRig({
      roots: () => [rootWith([face])],
      activeTrackNames: () => ["Face.morphTargetInfluences", "Face.position"],
    });

    expect(rig.list()[0]?.driven).toBe(true);
    expect(rig.setInfluence("obj-1", 0, 0, 0.5)).toBe(false);
    expect(face.morphTargetInfluences[0]).toBe(0);
  });

  it("only marks the mesh the clip actually binds", () => {
    const face = morphMesh(["Smile"]);
    face.name = "Face";
    const hand = morphMesh(["Open"]);
    hand.name = "Hand";
    const rig = createMorphRig({
      roots: () => [rootWith([face, hand])],
      activeTrackNames: () => ["Face.morphTargetInfluences"],
    });

    const listed = rig.list();
    expect(listed[0]?.driven).toBe(true);
    expect(listed[1]?.driven).toBe(false);
  });

  it("rejects unknown objects, meshes and targets", () => {
    const face = morphMesh(["Smile"]);
    const rig = createMorphRig({
      roots: () => [rootWith([face])],
      activeTrackNames: () => [],
    });

    expect(rig.setInfluence("nope", 0, 0, 0.5)).toBe(false);
    expect(rig.setInfluence("obj-1", 3, 0, 0.5)).toBe(false);
    expect(rig.setInfluence("obj-1", 0, 9, 0.5)).toBe(false);
    expect(rig.setInfluence("obj-1", 0, 0, Number.NaN)).toBe(false);
  });
});
