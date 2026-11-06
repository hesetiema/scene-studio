import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createNeutralEnvironment } from "../../src/three/viewer/neutral-environment";

describe("createNeutralEnvironment", () => {
  it("builds a grayscale studio: surround + four softboxes", () => {
    const environment = createNeutralEnvironment();

    const meshes: THREE.Mesh[] = [];
    environment.scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    // One surround box plus key / fill / rim / ceiling panels.
    expect(meshes).toHaveLength(5);

    // The point of `neutral`: no color stake in any direction.
    for (const mesh of meshes) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      const { r, g, b } = material.color;
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    environment.dispose();
  });

  it("keeps the key light brighter than the surround (HDR contrast)", () => {
    const environment = createNeutralEnvironment();
    const panels: number[] = [];
    let surround = -1;

    environment.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshBasicMaterial;
      // The surrounding box is inward-facing; the softboxes are panels.
      if (material.side === THREE.BackSide) surround = material.color.r;
      else panels.push(material.color.r);
    });

    expect(surround).toBeGreaterThanOrEqual(0);
    expect(surround).toBeLessThan(0.1);
    // HDR key light: far above the dark surround, and above the dimmest panel.
    expect(Math.max(...panels)).toBeGreaterThan(1);
    expect(Math.max(...panels)).toBeGreaterThan(Math.min(...panels) * 4);
    environment.dispose();
  });
});
