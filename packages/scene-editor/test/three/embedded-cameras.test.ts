import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  collectEmbeddedCameras,
  orbitTargetFor,
} from "../../src/three/viewer/embedded-cameras";

function cameraAt(position: [number, number, number], name = ""): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(...position);
  camera.name = name;
  camera.lookAt(0, 0, 0);
  return camera;
}

describe("collectEmbeddedCameras", () => {
  it("finds cameras anywhere under the roots, in traversal order", () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    const first = cameraAt([0, 0, 5], "Front");
    const second = cameraAt([5, 0, 0], "Side");
    group.add(second);
    root.add(first, group);

    const found = collectEmbeddedCameras([root]);
    expect(found.map((entry) => entry.name)).toEqual(["Front", "Side"]);
    expect(found[0]?.camera).toBe(first);
  });

  it("names unnamed cameras and de-duplicates repeated names", () => {
    const root = new THREE.Group();
    root.add(cameraAt([0, 0, 1]), cameraAt([0, 0, 2], "View"), cameraAt([0, 0, 3], "View"));

    const names = collectEmbeddedCameras([root]).map((entry) => entry.name);
    expect(names).toEqual(["Camera 1", "View", "View (2)"]);
  });

  it("ignores non-camera nodes and empty roots", () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry()), new THREE.Group());
    expect(collectEmbeddedCameras([root])).toEqual([]);
    expect(collectEmbeddedCameras([])).toEqual([]);
  });
});

describe("orbitTargetFor", () => {
  it("puts the pivot on the view axis, at the centre's projection", () => {
    // Camera on +Z looking at the origin; centre 4 units in front of it.
    const camera = cameraAt([0, 0, 10]);
    camera.updateWorldMatrix(true, false);
    const target = orbitTargetFor(camera, new THREE.Vector3(0, 0, 6));

    expect(target.x).toBeCloseTo(0, 5);
    expect(target.y).toBeCloseTo(0, 5);
    expect(target.z).toBeCloseTo(6, 5);
  });

  it("stays on the forward ray even when the centre is behind the camera", () => {
    const camera = cameraAt([0, 0, 10]);
    camera.updateWorldMatrix(true, false);
    const behind = new THREE.Vector3(0, 0, 30);
    const target = orbitTargetFor(camera, behind);

    // On the ray, in front of the lens (never behind it)…
    expect(target.z).toBeLessThan(10);
    expect(target.x).toBeCloseTo(0, 5);
    // …and at a usable fraction of the distance, not a degenerate zero.
    const distance = target.distanceTo(camera.position);
    expect(distance).toBeGreaterThan(4);
    expect(distance).toBeLessThan(6);
  });
});
