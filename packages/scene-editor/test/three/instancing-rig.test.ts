import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  BATCH_PROXY_LAYER,
  contentKey,
  geometryKey,
  materialKey,
} from "../../src/three/viewer/instancing/fingerprint";
import { planSpatialOrder } from "../../src/three/viewer/instancing/layout";
import { createInstancingRig } from "../../src/three/viewer/instancing-rig";

/**
 * Characterisation tests for the draw-call batcher.
 *
 * Nothing here needs a renderer: batches are plain scene-graph objects, so the
 * whole contract (eligibility, chunking, spatial layout, swap-removal, matrix
 * sync) is observable in node. These exist to keep a refactor of the 700-line
 * module honest — every assertion below pins a *behaviour*, not an internals
 * detail.
 */

function box(x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function chunkMeshes(rig: ReturnType<typeof createInstancingRig>): THREE.InstancedMesh[] {
  const root = rig.root();
  return root ? (root.children as THREE.InstancedMesh[]) : [];
}

/** Read slot `index` of a chunk's matrix buffer as a 16-element array. */
function slot(chunk: THREE.InstancedMesh, index: number): number[] {
  const array = chunk.instanceMatrix.array as Float32Array;
  return Array.from(array.subarray(index * 16, index * 16 + 16));
}

describe("content fingerprints", () => {
  it("gives identical stock materials the same key", () => {
    const a = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const b = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    expect(materialKey(a)).toBe(materialKey(b));
  });

  it("separates materials that differ in any surface field", () => {
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const rough = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.2 });
    expect(materialKey(red)).not.toBe(materialKey(blue));
    expect(materialKey(red)).not.toBe(materialKey(rough));
  });

  it("ignores version, so an edited material does not leave its batch", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x123456 });
    const before = materialKey(material);
    material.needsUpdate = true; // bumps `version`
    expect(materialKey(material)).toBe(before);
  });

  it("sorts defines, so declaration order cannot fake a difference", () => {
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    a.defines = { ALPHA: "1", BETA: "2" };
    b.defines = { BETA: "2", ALPHA: "1" };
    expect(materialKey(a)).toBe(materialKey(b));
  });

  it("refuses materials it cannot fingerprint exactly", () => {
    const clipped = new THREE.MeshStandardMaterial();
    (clipped as unknown as { clippingPlanes: unknown[] }).clippingPlanes = [];
    expect(materialKey(clipped)).toBeNull();
  });

  it("keys textures by identity, not by pixels", () => {
    const texture = new THREE.Texture();
    const a = new THREE.MeshStandardMaterial({ map: texture });
    const b = new THREE.MeshStandardMaterial({ map: texture });
    expect(materialKey(a)).toBe(materialKey(b));
    expect(materialKey(a)).not.toBe(
      materialKey(new THREE.MeshStandardMaterial({ map: new THREE.Texture() })),
    );
  });

  it("keys geometries by their declarative parameters", () => {
    expect(geometryKey(new THREE.BoxGeometry(1, 1, 1))).toBe(
      geometryKey(new THREE.BoxGeometry(1, 1, 1)),
    );
    expect(geometryKey(new THREE.BoxGeometry(1, 1, 1))).not.toBe(
      geometryKey(new THREE.BoxGeometry(1, 1, 2)),
    );
  });

  it("refuses geometries with no parameters (glTF buffers)", () => {
    expect(geometryKey(new THREE.BufferGeometry())).toBeNull();
  });
});

describe("spatial order", () => {
  it("says there is nothing to do when one chunk covers the group", () => {
    expect(planSpatialOrder([{ id: "a", x: 0, y: 0, z: 0 }], 256)).toBeNull();
  });

  it("emits every id exactly once, ordered by place", () => {
    const items = [
      { id: "far", x: 100, y: 0, z: 0 },
      { id: "near", x: 0, y: 0, z: 0 },
      { id: "mid", x: 50, y: 0, z: 0 },
    ];
    const order = planSpatialOrder(items, 1)!;
    expect(order.slice().sort()).toEqual(["far", "mid", "near"]);
    expect(order).toEqual(["near", "mid", "far"]);
  });

  it("culls a flat scene in 2D instead of spending cells on an empty axis", () => {
    // 64 boxes on one line, chunkSize 16: four chunks, each a contiguous run.
    const items = Array.from({ length: 64 }, (_, i) => ({ id: `i${i}`, x: i, y: 0, z: 0 }));
    const order = planSpatialOrder(items, 16)!;
    for (let chunk = 0; chunk < 4; chunk += 1) {
      const xs = order
        .slice(chunk * 16, chunk * 16 + 16)
        .map((id) => Number(id.slice(1)))
        .sort((a, b) => a - b);
      expect(xs[xs.length - 1]! - xs[0]!).toBeLessThanOrEqual(16);
    }
  });

  it("survives a fully degenerate scene (every member at one point)", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, x: 1, y: 1, z: 1 }));
    const order = planSpatialOrder(items, 4)!;
    expect(order).toHaveLength(10);
    expect(new Set(order).size).toBe(10);
  });
});

describe("content keys", () => {
  it("combines geometry and material, and refuses either half", () => {
    const mesh = box();
    expect(contentKey(mesh)).toContain("BoxGeometry");
    expect(contentKey(mesh)).toBe(contentKey(box()));

    const other = box();
    other.material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    expect(contentKey(other)).not.toBe(contentKey(mesh));

    const procedural = box();
    procedural.geometry = new THREE.BufferGeometry();
    expect(contentKey(procedural)).toBeNull();
  });
});

describe("eligibility", () => {
  function rig(): ReturnType<typeof createInstancingRig> {
    return createInstancingRig({ scene: new THREE.Scene() });
  }

  it("absorbs a repeated mesh and hides it on the proxy layer", () => {
    const target = rig();
    const mesh = box();
    expect(target.admit("a", mesh)).toBe(true);
    expect(mesh.layers.mask).toBe(1 << BATCH_PROXY_LAYER);
    // Still visible: framing, bounds and export walk `traverseVisible`.
    expect(mesh.visible).toBe(true);
  });

  it("refuses anything that is not a single-material leaf mesh", () => {
    const target = rig();

    const group = new THREE.Group();
    expect(target.admit("group", group)).toBe(false);

    const withChild = box();
    withChild.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    expect(target.admit("parent", withChild)).toBe(false);

    const multi = box();
    multi.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    expect(target.admit("multi", multi)).toBe(false);

    const glass = box();
    glass.material = new THREE.MeshStandardMaterial({ transparent: true });
    expect(target.admit("transparent", glass)).toBe(false);

    const faded = box();
    faded.material = new THREE.MeshStandardMaterial({ opacity: 0.5 });
    expect(target.admit("faded", faded)).toBe(false);

    // A mesh the host already put on its own layer keeps its draw call.
    const layered = box();
    layered.layers.set(2);
    expect(target.admit("layered", layered)).toBe(false);

    const procedural = box();
    procedural.geometry = new THREE.BufferGeometry();
    expect(target.admit("procedural", procedural)).toBe(false);

    expect(target.stats()).toEqual({ batches: 0, chunks: 0, instances: 0 });
  });

  it("is idempotent: re-admitting an id does not add an instance", () => {
    const target = rig();
    const mesh = box();
    expect(target.admit("a", mesh)).toBe(true);
    expect(target.admit("a", mesh)).toBe(true);
    expect(target.stats().instances).toBe(1);
  });

  it("splits batches by material, not by object", () => {
    const target = rig();
    target.admit("a", box());
    target.admit("b", box());
    const other = box();
    other.material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    target.admit("c", other);
    expect(target.stats()).toEqual({ batches: 2, chunks: 2, instances: 3 });
  });
});

describe("chunking", () => {
  it("caps instances per InstancedMesh at chunkSize", () => {
    const target = createInstancingRig({ scene: new THREE.Scene(), chunkSize: 4 });
    for (let i = 0; i < 10; i += 1) target.admit(`b${i}`, box(i));
    expect(target.stats()).toEqual({ batches: 1, chunks: 3, instances: 10 });

    const chunks = chunkMeshes(target);
    expect(chunks.map((mesh) => mesh.count)).toEqual([4, 4, 2]);
    // One geometry + one material for the whole group: chunking must not
    // multiply GPU memory.
    expect(chunks[0]!.geometry).toBe(chunks[1]!.geometry);
    expect(chunks[0]!.material).toBe(chunks[1]!.material);
  });

  it("writes each member's world matrix into its slot", () => {
    const target = createInstancingRig({ scene: new THREE.Scene(), chunkSize: 4 });
    const meshes = [box(1), box(2), box(3)];
    meshes.forEach((mesh, index) => target.admit(`m${index}`, mesh));

    const [chunk] = chunkMeshes(target);
    meshes.forEach((mesh, index) => {
      expect(slot(chunk!, index)[12]).toBeCloseTo(mesh.matrixWorld.elements[12]!);
      expect(slot(chunk!, index)[13]).toBeCloseTo(mesh.matrixWorld.elements[13]!);
    });
  });

  it("drops the cull volume instead of recomputing it per admit", () => {
    const target = createInstancingRig({ scene: new THREE.Scene() });
    target.admit("a", box());
    // `null` means "three recomputes on the next frustum test", i.e. once per
    // frame rather than once per object.
    expect(chunkMeshes(target)[0]!.boundingSphere).toBeNull();
  });
});

describe("spatial layout", () => {
  it("keeps a chunk inside one spatial cluster, not one admission block", () => {
    const target = createInstancingRig({ scene: new THREE.Scene(), chunkSize: 4 });
    // Two clusters 100 units apart, admitted in interleaved order: append order
    // would produce chunks that each span both clusters.
    const left: THREE.Mesh[] = [];
    const right: THREE.Mesh[] = [];
    for (let i = 0; i < 8; i += 1) {
      left.push(box(-100 + i * 0.1));
      right.push(box(100 + i * 0.1));
    }
    for (let i = 0; i < 8; i += 1) {
      target.admit(`l${i}`, left[i]!);
      target.admit(`r${i}`, right[i]!);
    }
    target.sync();

    const chunks = chunkMeshes(target);
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) {
      const xs = Array.from({ length: chunk.count }, (_, index) => slot(chunk, index)[12]!);
      const spread = Math.max(...xs) - Math.min(...xs);
      // A block of interleaved members would spread ~200 units.
      expect(spread).toBeLessThan(5);
    }
    expect(target.stats().instances).toBe(16);
  });

  it("re-lays out after a removal leaves a gap", () => {
    const target = createInstancingRig({ scene: new THREE.Scene(), chunkSize: 4 });
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < 12; i += 1) {
      meshes.push(box(i));
      target.admit(`m${i}`, meshes[i]!);
    }
    target.sync();
    target.detach("m0");
    target.sync();
    expect(target.stats()).toEqual({ batches: 1, chunks: 3, instances: 11 });
    // 11 members over chunkSize 4 → 4 + 4 + 3.
    expect(chunkMeshes(target).map((chunk) => chunk.count)).toEqual([4, 4, 3]);
  });
});

describe("release", () => {
  it("swap-removes a member and keeps every remaining slot aligned", () => {
    const target = createInstancingRig({ scene: new THREE.Scene(), chunkSize: 4 });
    const meshes = [box(1), box(2), box(3), box(4), box(5)];
    meshes.forEach((mesh, index) => target.admit(`m${index}`, mesh));

    target.exclude("m1");
    expect(target.stats()).toEqual({ batches: 1, chunks: 2, instances: 4 });
    // Excluding is not detaching: it draws itself again.
    expect(meshes[1]!.layers.mask).toBe(1);

    // The freed slot was filled by the chunk's last member; the union of every
    // written slot must still be exactly the surviving proxies.
    const survivors = [meshes[0]!, meshes[2]!, meshes[3]!, meshes[4]!].map(
      (mesh) => mesh.matrixWorld.elements[12]!,
    );
    const written = chunkMeshes(target).flatMap((chunk) =>
      Array.from({ length: chunk.count }, (_, index) => slot(chunk, index)[12]!),
    );
    expect(written.sort((a, b) => a - b)).toEqual(survivors.sort((a, b) => a - b));
  });

  it("drops the batch and the root once the last member leaves", () => {
    const scene = new THREE.Scene();
    const target = createInstancingRig({ scene });
    const mesh = box();
    target.admit("a", mesh);
    expect(target.root()?.name).toBe("scene-batches");
    expect(scene.children).toContain(target.root());

    target.detach("a");
    expect(target.stats()).toEqual({ batches: 0, chunks: 0, instances: 0 });
    expect(target.root()).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(mesh.layers.mask).toBe(1);
  });

  it("restores every proxy and disposes the group's own clones on clear", () => {
    const target = createInstancingRig({ scene: new THREE.Scene() });
    const first = box(1);
    const second = box(2);
    target.admit("a", first);
    target.admit("b", second);

    const chunk = chunkMeshes(target)[0]!;
    const geometryDispose = vi.spyOn(chunk.geometry, "dispose");
    const materialDispose = vi.spyOn(chunk.material as THREE.Material, "dispose");
    const meshDispose = vi.spyOn(chunk, "dispose");

    target.clear();
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(meshDispose).toHaveBeenCalled();
    expect(first.layers.mask).toBe(1);
    expect(second.layers.mask).toBe(1);
    expect(target.stats()).toEqual({ batches: 0, chunks: 0, instances: 0 });
  });
});

describe("matrix sync", () => {
  it("pushes a moved proxy's matrix on the next sync", () => {
    const target = createInstancingRig({ scene: new THREE.Scene() });
    const mesh = box(1);
    target.admit("a", mesh);
    target.sync();

    mesh.position.x = 9;
    mesh.updateMatrixWorld(true);
    target.markDirty(mesh);
    target.sync();

    expect(slot(chunkMeshes(target)[0]!, 0)[12]).toBeCloseTo(9);
  });

  it("uploads nothing while the scene is static", () => {
    const target = createInstancingRig({ scene: new THREE.Scene() });
    const mesh = box(1);
    target.admit("a", mesh);
    target.sync();

    const attribute = chunkMeshes(target)[0]!.instanceMatrix;
    const version = attribute.version;
    target.sync();
    target.sync();
    // three bumps `version` only when `needsUpdate` was set.
    expect(attribute.version).toBe(version);
  });

  it("follows a moved group, not just a moved leaf", () => {
    const target = createInstancingRig({ scene: new THREE.Scene() });
    const group = new THREE.Group();
    const mesh = box(1);
    group.add(mesh);
    group.updateMatrixWorld(true);
    target.admit("a", mesh);
    target.sync();

    group.position.x = 5;
    group.updateMatrixWorld(true);
    target.markDirty(group);
    target.sync();
    expect(slot(chunkMeshes(target)[0]!, 0)[12]).toBeCloseTo(6);
  });
});
