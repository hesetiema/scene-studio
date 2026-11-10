import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createNeutralEnvironment } from "../../src/three/viewer/neutral-environment";

interface Survey {
  room: THREE.Mesh | undefined;
  occluders: THREE.MeshStandardMaterial[];
  panels: THREE.MeshBasicMaterial[];
  pointLights: THREE.PointLight[];
}

function survey(): Survey {
  const environment = createNeutralEnvironment();
  const meshes: THREE.Mesh[] = [];
  environment.scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
  });

  const result: Survey = {
    room: meshes.find(
      (mesh) => (mesh.material as THREE.MeshStandardMaterial).side === THREE.BackSide,
    ),
    occluders: meshes
      .map((mesh) => mesh.material as THREE.MeshStandardMaterial)
      .filter((material) => material.isMeshStandardMaterial && material.side !== THREE.BackSide),
    panels: meshes
      .map((mesh) => mesh.material as THREE.MeshBasicMaterial)
      .filter((material) => material.isMeshBasicMaterial),
    pointLights: environment.scene.children.filter(
      (child): child is THREE.PointLight => (child as THREE.PointLight).isPointLight,
    ),
  };
  environment.dispose();
  return result;
}

describe("createNeutralEnvironment", () => {
  it("ports model-viewer's neutral room: room + six occluders + seven panels", () => {
    const { room, occluders, panels } = survey();

    expect(room).toBeDefined();
    expect(occluders).toHaveLength(6);
    expect(panels).toHaveLength(7);
  });

  it("lights the room instead of making it emissive", () => {
    const { room, occluders, pointLights } = survey();

    // The gradients that make the reference environment read the way it does
    // come from a diffuse room lit by one point light — not from flat panels.
    expect((room!.material as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    for (const material of occluders) expect(material.metalness).toBe(0);
    expect(pointLights).toHaveLength(1);
    expect(pointLights[0]?.intensity).toBe(400);
  });

  it("keeps every emitter grayscale so the probe cannot tint the model", () => {
    const { room, occluders, panels } = survey();

    for (const material of [room!.material, ...occluders, ...panels]) {
      const { r, g, b } = (material as THREE.MeshBasicMaterial).color;
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  it("keeps the key panel far above the room's own brightness", () => {
    const { panels } = survey();
    const intensities = panels.map((material) => material.color.r);

    expect(Math.max(...intensities)).toBeGreaterThanOrEqual(80);
    expect(Math.max(...intensities)).toBeGreaterThan(Math.min(...intensities) * 8);
  });
});
