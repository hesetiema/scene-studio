import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { measureFraming } from "../../src/three/viewer/framing";

function sceneWith(...objects: THREE.Object3D[]): THREE.Object3D[] {
  const scene = new THREE.Scene();
  for (const object of objects) scene.add(object);
  scene.updateMatrixWorld(true);
  return [scene];
}

const CENTER = new THREE.Vector3(0, 0, 0);

describe("measureFraming", () => {
  it("measures to the farthest vertex, not to a box corner", () => {
    // A sphere fills only 52% of its bounding box: corner≈1.732, vertices=1.
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16));

    const metrics = measureFraming(sceneWith(sphere), CENTER);

    expect(metrics).toBeDefined();
    expect(metrics!.radius).toBeCloseTo(1, 2);
  });

  it("reports the horizontal tangent a given distance can cover", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16));
    const distance = 1 / Math.sin(THREE.MathUtils.degToRad(15));

    const tan = measureFraming(sceneWith(sphere), CENTER)!.horizontalTanAt(distance);

    // A sphere's widest silhouette is its equator, so the tangent is ≥ 1/d —
    // and only a hair above it, from vertices just off the equator sitting
    // slightly closer to the camera.
    expect(tan).toBeGreaterThan(1 / distance);
    expect(tan).toBeLessThan((1 / distance) * 1.05);
  });

  it("follows world transforms and ignores hidden geometry", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(10, 0, 0);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100));
    hidden.visible = false;

    const metrics = measureFraming(sceneWith(mesh, hidden), new THREE.Vector3(10, 0, 0));

    expect(metrics!.radius).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("returns undefined when nothing carries geometry", () => {
    expect(measureFraming(sceneWith(new THREE.Group()), CENTER)).toBeUndefined();
    expect(measureFraming([], CENTER)).toBeUndefined();
  });
});
