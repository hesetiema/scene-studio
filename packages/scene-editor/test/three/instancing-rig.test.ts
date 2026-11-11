// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BATCH_PROXY_LAYER,
  createInstancingRig,
  geometryKey,
  materialKey,
} from "../../src/three/viewer/instancing-rig";

const BASE_COLOR = 0x4f8ef7;

/** One document object: its own geometry *and* its own material instance. */
function box(id: string, position: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: BASE_COLOR }),
  );
  mesh.position.set(...position);
  mesh.userData.sceneObjectId = id;
  return mesh;
}

function setup() {
  const scene = new THREE.Scene();
  const rig = createInstancingRig({ scene });
  return { scene, rig };
}

function batchMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh === true) {
      found.push(child as THREE.InstancedMesh);
    }
  });
  return found;
}

describe("geometryKey / materialKey", () => {
  it("keys equal geometries to the same string and different ones apart", () => {
    expect(geometryKey(new THREE.BoxGeometry(1, 1, 1))).toBe(
      geometryKey(new THREE.BoxGeometry(1, 1, 1)),
    );
    expect(geometryKey(new THREE.BoxGeometry(1, 1, 1))).not.toBe(
      geometryKey(new THREE.BoxGeometry(2, 1, 1)),
    );
    // A glTF buffer has no declarative parameters → never merged.
    expect(geometryKey(new THREE.BufferGeometry())).toBeNull();
  });

  it("ignores identity fields but keeps every surface field", () => {
    const a = new THREE.MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.4 });
    const b = new THREE.MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.4 });
    // Different instances, different uuids — still the same appearance.
    expect(materialKey(a)).toBe(materialKey(b));

    const warmer = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.4 });
    expect(materialKey(warmer)).not.toBe(materialKey(a));

    // Mutating a visual field changes the key…
    b.roughness = 0.9;
    expect(materialKey(b)).not.toBe(materialKey(a));
    // …and `version` churn alone never does.
    a.needsUpdate = true;
    expect(materialKey(a)).toBe(materialKey(new THREE.MeshStandardMaterial({
      color: BASE_COLOR,
      roughness: 0.4,
    })));
  });

  it("refuses materials it cannot fingerprint exactly", () => {
    const basic = new THREE.MeshStandardMaterial();
    (basic as unknown as { clippingPlanes: unknown }).clippingPlanes = [new THREE.Plane()];
    expect(materialKey(basic)).toBeNull();
  });
});

describe("instancing rig", () => {
  it("collapses identical primitives into one instanced draw", () => {
    const { scene, rig } = setup();
    const meshes = [box("a", [0, 0, 0]), box("b", [1, 0, 0]), box("c", [2, 0, 0])];
    scene.add(...meshes);

    for (const mesh of meshes) expect(rig.admit(mesh.userData.sceneObjectId as string, mesh)).toBe(true);

    const [batch] = batchMeshes(scene);
    expect(batchMeshes(scene)).toHaveLength(1);
    expect(batch!.count).toBe(3);
    expect(rig.stats()).toEqual({ batches: 1, chunks: 1, instances: 3 });
    // Proxies stop drawing but stay in the graph, visible, with their geometry.
    for (const mesh of meshes) {
      expect(mesh.layers.mask).toBe(1 << BATCH_PROXY_LAYER);
      expect(mesh.visible).toBe(true);
      expect(mesh.parent).toBe(scene);
    }
    rig.dispose();
  });

  it("keys batches by content, not by instance", () => {
    const { scene, rig } = setup();
    const unit = box("a");
    const big = new THREE.Mesh(
      new THREE.BoxGeometry(5, 5, 5),
      new THREE.MeshStandardMaterial({ color: BASE_COLOR }),
    );
    const red = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    );
    scene.add(unit, big, red);

    rig.admit("a", unit);
    rig.admit("big", big);
    rig.admit("red", red);

    expect(rig.stats()).toEqual({ batches: 3, chunks: 3, instances: 3 });
    rig.dispose();
  });

  it("leaves anything that needs its own draw call alone", () => {
    const { scene, rig } = setup();

    const transparent = box("t");
    (transparent.material as THREE.MeshStandardMaterial).transparent = true;
    (transparent.material as THREE.MeshStandardMaterial).opacity = 0.5;

    const withChild = box("c");
    withChild.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2)));

    const custom = box("l");
    custom.layers.set(2);

    const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());

    scene.add(transparent, withChild, custom, plain);
    expect(rig.admit("t", transparent)).toBe(false);
    expect(rig.admit("c", withChild)).toBe(false);
    expect(rig.admit("l", custom)).toBe(false);
    expect(rig.admit("p", plain)).toBe(false);
    expect(rig.stats()).toEqual({ batches: 0, chunks: 0, instances: 0 });
    rig.dispose();
  });

  it("hands a member its own draw call back without disturbing the others", () => {
    const { scene, rig } = setup();
    const meshes = [box("a", [0, 0, 0]), box("b", [3, 0, 0]), box("c", [6, 0, 0])];
    scene.add(...meshes);
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) rig.admit(mesh.userData.sceneObjectId as string, mesh);

    rig.exclude("b");

    const [batch] = batchMeshes(scene);
    expect(batch!.count).toBe(2);
    expect(meshes[1]!.layers.mask).toBe(1);
    // The swap-remove moved the last member into the freed slot, matrix included.
    const matrix = new THREE.Matrix4();
    batch!.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(0, 5);
    batch!.getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBeCloseTo(6, 5);

    // …and it can come back.
    expect(rig.admit("b", meshes[1]!)).toBe(true);
    expect(batch!.count).toBe(3);
    rig.dispose();
  });

  it("removes the batch root once nothing is batched, and disposes its clones", () => {
    const { scene, rig } = setup();
    const mesh = box("a");
    scene.add(mesh);
    rig.admit("a", mesh);

    const [batch] = batchMeshes(scene);
    const geometry = batch!.geometry;
    const dispose = geometry.dispose.bind(geometry);
    let disposed = false;
    geometry.dispose = () => {
      disposed = true;
      dispose();
    };

    expect(rig.root()).not.toBeNull();
    rig.detach("a");

    expect(disposed).toBe(true);
    expect(batchMeshes(scene)).toHaveLength(0);
    expect(rig.root()).toBeNull();
    expect(mesh.layers.mask).toBe(1);
    rig.dispose();
  });

  it("follows world matrices, including a moved parent", () => {
    const { scene, rig } = setup();
    const group = new THREE.Group();
    scene.add(group);
    const mesh = box("a", [1, 0, 0]);
    group.add(mesh);
    scene.updateMatrixWorld(true);
    rig.admit("a", mesh);

    group.position.set(5, 0, 0);
    // The *group* moved; the batched child is the one that needs a new matrix.
    rig.markDirty(group);
    rig.sync();

    const [batch] = batchMeshes(scene);
    const matrix = new THREE.Matrix4();
    batch!.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(6, 5);
    rig.dispose();
  });

  it("uploads only when a matrix actually changed", () => {
    const { scene, rig } = setup();
    const mesh = box("a", [2, 0, 0]);
    scene.add(mesh);
    rig.admit("a", mesh);
    const [batch] = batchMeshes(scene);

    rig.sync();
    const version = batch!.instanceMatrix.version;
    // Nothing moved: no re-upload.
    rig.sync();
    expect(batch!.instanceMatrix.version).toBe(version);

    mesh.position.x = 4;
    rig.markDirty(mesh);
    rig.sync();
    expect(batch!.instanceMatrix.version).toBeGreaterThan(version);
    rig.dispose();
  });

  it("grows past its initial capacity without losing slots", () => {
    const { scene, rig } = setup();
    const meshes = Array.from({ length: 40 }, (_, i) => box(`m-${i}`, [i, 0, 0]));
    scene.add(...meshes);
    scene.updateMatrixWorld(true);
    for (let i = 0; i < meshes.length; i += 1) rig.admit(`m-${i}`, meshes[i]!);

    const [batch] = batchMeshes(scene);
    expect(batch!.count).toBe(40);
    const matrix = new THREE.Matrix4();
    batch!.getMatrixAt(39, matrix);
    expect(matrix.elements[12]).toBeCloseTo(39, 5);
    rig.dispose();
  });

  /** X offsets of the instances a chunk draws, in slot order. */
  function chunkXs(chunk: THREE.InstancedMesh): number[] {
    const matrix = new THREE.Matrix4();
    return Array.from({ length: chunk.count }, (_, i) => {
      chunk.getMatrixAt(i, matrix);
      return Math.round(matrix.elements[12]!);
    });
  }

  it("splits one content group into independently cullable chunks", () => {
    const scene = new THREE.Scene();
    const rig = createInstancingRig({ scene, chunkSize: 2 });
    // 0, 10, 20, 30, 40 on X → chunks of 2, 2, 1.
    const meshes = Array.from({ length: 5 }, (_, i) => box(`m-${i}`, [i * 10, 0, 0]));
    scene.add(...meshes);
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) {
      rig.admit(mesh.userData.sceneObjectId as string, mesh);
    }

    const chunks = batchMeshes(scene);
    expect(chunks.map((chunk) => chunk.count)).toEqual([2, 2, 1]);
    expect(rig.stats()).toEqual({ batches: 1, chunks: 3, instances: 5 });
    // Chunking multiplies draw calls, not memory: one geometry, one material.
    expect(chunks[0]!.geometry).toBe(chunks[2]!.geometry);
    expect(chunks[0]!.material).toBe(chunks[2]!.material);

    // A frustum covering x ∈ [-12, 12] at z = 0 sees the first chunk only —
    // the whole reason chunks exist (one sphere per group would see all five).
    const camera = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.1, 200);
    camera.position.set(0, 0, 50);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    scene.updateMatrixWorld(true);
    const visible = chunks.filter((chunk) => frustum.intersectsObject(chunk));
    expect(visible).toHaveLength(1);
    expect(chunkXs(visible[0]!)).toEqual([0, 10]);
    rig.dispose();
  });

  it("buckets a shuffled group into spatial chunks on the next sync", () => {
    const scene = new THREE.Scene();
    // 4×4 grid, 10 units apart, admitted in an order that has nothing to do with
    // where the boxes are: a chunk cut from admission order would span the whole
    // grid and cull nothing.
    const rig = createInstancingRig({ scene, chunkSize: 4 });
    const positions: Array<[number, number]> = [
      [0, 0],
      [30, 30],
      [10, 0],
      [20, 30],
      [0, 10],
      [30, 20],
      [10, 10],
      [20, 20],
      [0, 20],
      [30, 10],
      [10, 20],
      [20, 10],
      [0, 30],
      [30, 0],
      [10, 30],
      [20, 0],
    ];
    const meshes = positions.map(([x, z], i) => {
      const mesh = box(`m-${i}`, [x, 0, z]);
      scene.add(mesh);
      return mesh;
    });
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) rig.admit(mesh.userData.sceneObjectId as string, mesh);

    // Deferred: the layout happens on the frame, not inside `admit`.
    rig.sync();

    const chunks = batchMeshes(scene);
    expect(chunks).toHaveLength(4);
    // Every chunk is one grid cell: 4 instances, all within the same 15-unit
    // bucket on both axes.
    for (const chunk of chunks) {
      expect(chunk.count).toBe(4);
      // Same clamp the rig applies: the far edge would otherwise index 2.
      const cells = chunkXs(chunk).map((x) => Math.min(1, Math.floor(x / 15)));
      expect(new Set(cells).size).toBe(1);
      const zs = Array.from({ length: chunk.count }, (_, i) => {
        const matrix = new THREE.Matrix4();
        chunk.getMatrixAt(i, matrix);
        return Math.min(1, Math.floor(matrix.elements[14]! / 15));
      });
      expect(new Set(zs).size).toBe(1);
    }

    // …and the frustum now works per cell: a narrow camera down -Z sees the two
    // chunks of one column, not the whole grid (append-order chunks, each
    // spanning the grid, would all four intersect).
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    camera.position.set(5, 5, 55);
    camera.lookAt(5, 0, 5);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const visible = chunks.filter((chunk) => frustum.intersectsObject(chunk));
    expect(visible).toHaveLength(2);
    const columns = new Set(
      visible.map((chunk) => Math.min(1, Math.floor(chunkXs(chunk)[0]! / 15))),
    );
    expect(columns.size).toBe(1);
    rig.dispose();
  });

  it("keeps survivor slots valid when a middle chunk empties", () => {
    const scene = new THREE.Scene();
    const rig = createInstancingRig({ scene, chunkSize: 2 });
    const meshes = Array.from({ length: 5 }, (_, i) => box(`m-${i}`, [i * 10, 0, 0]));
    scene.add(...meshes);
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) {
      rig.admit(mesh.userData.sceneObjectId as string, mesh);
    }
    // Chunks: [0, 10] [20, 30] [40]. Drain the middle one.
    rig.detach("m-2");
    rig.detach("m-3");

    const chunks = batchMeshes(scene);
    expect(chunks.map(chunkXs)).toEqual([[0, 10], [40]]);
    // The chunk that slid into the freed index kept its members addressable:
    // a later move must land in *that* chunk's matrix, not a stale slot.
    meshes[4]!.position.x = 45;
    rig.markDirty(meshes[4]!);
    rig.sync();
    expect(chunkXs(batchMeshes(scene)[1]!)).toEqual([45]);
    expect(rig.stats()).toEqual({ batches: 1, chunks: 2, instances: 3 });
    rig.dispose();
  });
});
