import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  createSharedResourcePool,
  primitiveSignature,
} from "../../src/three/viewer/shared-resources";
import {
  createPlaceholderObject,
  createPrimitiveObject,
} from "../../src/three/viewer/object-factory";
import type { SceneObjectDTO } from "../../src/core/document/schema";

function dto(id: string, geometry?: SceneObjectDTO["geometry"]): SceneObjectDTO {
  return {
    id,
    type: "primitive",
    name: id,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...(geometry ? { geometry } : {}),
  } as SceneObjectDTO;
}

describe("shared resource pool", () => {
  it("hands the same buffer to every caller of one key", () => {
    const pool = createSharedResourcePool();
    const a = pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));
    const b = pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));

    expect(a).toBe(b);
    expect(pool.stats()).toEqual({ geometries: 1, materials: 0, references: 2 });
  });

  it("keeps different keys apart", () => {
    const pool = createSharedResourcePool();
    const a = pool.geometry("box:1", () => new THREE.BoxGeometry(1, 1, 1));
    const b = pool.geometry("box:2", () => new THREE.BoxGeometry(2, 1, 1));

    expect(a).not.toBe(b);
    expect(pool.stats().geometries).toBe(2);
  });

  it("disposes only when the last reference goes", () => {
    const pool = createSharedResourcePool();
    const geometry = pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));
    const dispose = vi.spyOn(geometry, "dispose");
    pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));

    pool.release(geometry);
    expect(dispose).not.toHaveBeenCalled();
    expect(pool.stats()).toEqual({ geometries: 1, materials: 0, references: 1 });

    pool.release(geometry);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toEqual({ geometries: 0, materials: 0, references: 0 });
  });

  it("ignores a double release instead of disposing twice", () => {
    const pool = createSharedResourcePool();
    const material = pool.material("m", () => new THREE.MeshStandardMaterial());
    const dispose = vi.spyOn(material, "dispose");

    pool.release(material);
    pool.release(material);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toEqual({ geometries: 0, materials: 0, references: 0 });
  });

  it("disposes everything on teardown, refcounts or not", () => {
    const pool = createSharedResourcePool();
    const geometry = pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));
    const material = pool.material("m", () => new THREE.MeshStandardMaterial());
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");

    pool.dispose();

    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    // Re-use after teardown starts from a clean slate, not a stale buffer.
    const next = pool.geometry("box", () => new THREE.BoxGeometry(1, 1, 1));
    expect(next).not.toBe(geometry);
  });
});

describe("primitiveSignature", () => {
  it("resolves defaults, so omitted and explicit fields are one buffer", () => {
    expect(primitiveSignature({ kind: "box" })).toBe(
      primitiveSignature({
        kind: "box",
        width: 1,
        height: 1,
        depth: 1,
        widthSegments: 1,
        heightSegments: 1,
        depthSegments: 1,
      }),
    );
  });

  it("separates kinds and dimensions", () => {
    expect(primitiveSignature({ kind: "box" })).not.toBe(primitiveSignature({ kind: "sphere" }));
    expect(primitiveSignature({ kind: "box", width: 2 })).not.toBe(
      primitiveSignature({ kind: "box" }),
    );
  });

  it("treats a missing geometry as the default box", () => {
    expect(primitiveSignature(undefined)).toBe(primitiveSignature({ kind: "box" }));
  });
});

describe("object factory sharing", () => {
  it("gives two identical primitives one geometry and one material", () => {
    const pool = createSharedResourcePool();
    const a = createPrimitiveObject(dto("a"), pool);
    const b = createPrimitiveObject(dto("b"), pool);

    expect(a.object.geometry).toBe(b.object.geometry);
    expect(a.object.material).toBe(b.object.material);
    expect(pool.stats()).toEqual({ geometries: 1, materials: 1, references: 4 });
  });

  it("shares the default box between a primitive and a placeholder", () => {
    const pool = createSharedResourcePool();
    const primitive = createPrimitiveObject(dto("a", { kind: "box" }), pool);
    const placeholder = createPlaceholderObject(dto("b"), pool);

    expect(primitive.object.geometry).toBe(placeholder.object.geometry);
  });

  it("releases on dispose instead of freeing what a sibling still uses", () => {
    const pool = createSharedResourcePool();
    const a = createPrimitiveObject(dto("a"), pool);
    const b = createPrimitiveObject(dto("b"), pool);
    const disposeGeometry = vi.spyOn(a.object.geometry, "dispose");

    a.dispose();
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(b.object.geometry.attributes.position).toBeDefined();

    b.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toEqual({ geometries: 0, materials: 0, references: 0 });
  });

  it("keeps distinct dimensions distinct", () => {
    const pool = createSharedResourcePool();
    const small = createPrimitiveObject(dto("a", { kind: "sphere", radius: 0.5 }), pool);
    const large = createPrimitiveObject(dto("b", { kind: "sphere", radius: 2 }), pool);

    expect(small.object.geometry).not.toBe(large.object.geometry);
    expect(pool.stats().geometries).toBe(2);
  });
});
