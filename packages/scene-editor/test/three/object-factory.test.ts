import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyMaterialFields,
  applyMaterialOverride,
  createPrimitiveGeometry,
  createPrimitiveObject,
} from "../../src/three/viewer/object-factory";
import { sceneObject } from "../support/documents";

const KINDS = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
  "capsule",
  "icosahedron",
] as const;

describe("createPrimitiveGeometry", () => {
  it("builds every supported kind from defaults", () => {
    for (const kind of KINDS) {
      const geometry = createPrimitiveGeometry({ kind } as never);
      expect(geometry, kind).toBeInstanceOf(THREE.BufferGeometry);
      expect(geometry.attributes.position?.count ?? 0, kind).toBeGreaterThan(0);
      geometry.dispose();
    }
  });

  it("honours explicit parameters", () => {
    const sphere = createPrimitiveGeometry({ kind: "sphere", radius: 2 }) as THREE.SphereGeometry;
    expect(sphere.parameters.radius).toBe(2);

    const box = createPrimitiveGeometry({
      kind: "box",
      width: 3,
      height: 4,
      depth: 5,
    }) as THREE.BoxGeometry;
    expect(box.parameters).toMatchObject({ width: 3, height: 4, depth: 5 });

    const torus = createPrimitiveGeometry({
      kind: "torus",
      radius: 1,
      tube: 0.1,
    }) as THREE.TorusGeometry;
    expect(torus.parameters).toMatchObject({ radius: 1, tube: 0.1 });
  });
});

describe("createPrimitiveObject", () => {
  it("uses the document geometry and transform with a neutral base material", () => {
    const built = createPrimitiveObject(
      sceneObject({
        id: "prim",
        name: "Prim",
        type: "primitive",
        geometry: { kind: "torus" },
        position: [1, 2, 3],
      }),
    );

    const mesh = built.object;
    expect(mesh.geometry).toBeInstanceOf(THREE.TorusGeometry);
    expect(mesh.position.toArray()).toEqual([1, 2, 3]);
    expect(mesh.userData.sceneObjectId).toBe("prim");

    // The document's `material` is applied by the object store, so one code path
    // owns override *and* restore; the factory only supplies the base surface.
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("4f8ef7");

    built.dispose();
  });

  it("falls back to a box when geometry is absent", () => {
    const built = createPrimitiveObject(sceneObject({ type: "primitive" }));
    expect(built.object.geometry).toBeInstanceOf(THREE.BoxGeometry);
    built.dispose();
  });
});

describe("applyMaterialFields", () => {
  it("writes only the declared fields", () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0.5,
    });

    applyMaterialFields(material, { color: "#123456" });

    expect(material.color.getHexString()).toBe("123456");
    expect(material.roughness).toBe(0.25);
    expect(material.metalness).toBe(0.5);
  });

  it("derives transparent from opacity", () => {
    const material = new THREE.MeshStandardMaterial();
    applyMaterialFields(material, { opacity: 0.4 });

    expect(material.opacity).toBe(0.4);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });

  it("leaves unsupported parameters alone instead of failing", () => {
    const basic = new THREE.MeshBasicMaterial({ color: 0xffffff });
    expect(() => applyMaterialFields(basic, { metalness: 1, roughness: 0 })).not.toThrow();
    expect(basic.color.getHexString()).toBe("ffffff");
  });
});

describe("applyMaterialOverride", () => {
  it("clones before writing so a shared material is untouched", () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const target = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const sibling = new THREE.Mesh(new THREE.BoxGeometry(), shared);

    const handle = applyMaterialOverride(target, { color: "#ff0000" });

    expect(target.material).not.toBe(shared);
    expect(sibling.material).toBe(shared);
    expect(shared.color.getHexString()).toBe("ffffff");
    expect((target.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("ff0000");
    expect(handle.materials).toHaveLength(1);

    handle.restore();
    expect(target.material).toBe(shared);
    expect(handle.materials).toHaveLength(0);
    // Idempotent: a second restore must not resurrect the clones.
    handle.restore();

    shared.dispose();
  });

  it("walks the whole subtree and handles material arrays", () => {
    const root = new THREE.Group();
    const single = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshBasicMaterial(),
    ]);
    root.add(single, multi);
    const originalArray = multi.material;

    const handle = applyMaterialOverride(root, { opacity: 0.5 });

    expect(handle.materials).toHaveLength(3);
    expect(single.material).toBe(handle.materials[0]);
    expect(Array.isArray(multi.material)).toBe(true);
    expect(handle.materials.every((material) => material.opacity === 0.5)).toBe(true);

    handle.restore();
    expect(multi.material).toBe(originalArray);
  });
});
