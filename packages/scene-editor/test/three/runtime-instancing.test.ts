// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { BATCH_PROXY_LAYER } from "../../src/three/viewer/instancing-rig";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

function stubRenderer() {
  return {
    domElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    },
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeRuntime(extra: Record<string, unknown> = {}) {
  return new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: stubRenderer as never,
    enableControls: false,
    ...extra,
  } as never);
}

/** `count` placeholder boxes on the X axis, one document unit apart. */
function boxes(count: number): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "batch",
    revision: 0,
    objects: Array.from({ length: count }, (_, i) => ({
      id: `box-${i}`,
      type: "mesh" as const,
      name: `Box ${i}`,
      position: [i - (count - 1) / 2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    view: createDefaultViewState(),
  };
}

function batches(runtime: ThreeRuntime): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  runtime.scene.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh === true) {
      found.push(child as THREE.InstancedMesh);
    }
  });
  return found;
}

describe("ThreeRuntime instancing", () => {
  it("draws repeated primitives once instead of N times", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));

    const [batch] = batches(runtime);
    expect(batches(runtime)).toHaveLength(1);
    expect(batch!.count).toBe(3);
    // The document still sees three objects at their own positions.
    expect(runtime.dimensions().width).toBeCloseTo(3, 5);
    expect(runtime.getObjectById("box-2")!.position.x).toBeCloseTo(1, 5);
    // Proxies keep their geometry; they are only off the rendered layer.
    for (const id of ["box-0", "box-1", "box-2"]) {
      const proxy = runtime.getObjectById(id) as THREE.Mesh;
      expect(proxy.layers.mask).toBe(1 << BATCH_PROXY_LAYER);
      expect(proxy.visible).toBe(true);
      expect(proxy.geometry).toBeInstanceOf(THREE.BufferGeometry);
    }
  });

  it("keeps picking exact, including the raycast layer opt-in", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));
    runtime.scene.updateMatrixWorld(true);

    // What `picker.ts` gets: the document objects, not the scene furniture.
    const roots = runtime.scene.children.filter(
      (child) => child.userData.sceneObjectId !== undefined,
    );
    expect(roots).toHaveLength(3);

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(0, 0, -1),
    );
    raycaster.layers.enableAll();
    const [hit] = raycaster.intersectObjects(roots, true);
    expect(hit?.object.userData.sceneObjectId).toBe("box-1");
    expect(hit?.point.z).toBeCloseTo(0.5, 5);

    // The batch itself is drawing-only; a host that raycasts the whole scene
    // never gets an anonymous instance back.
    const batchRoot = runtime.scene.children.find((child) => child.userData.sceneBatchRoot);
    expect(batchRoot).toBeDefined();
    expect(raycaster.intersectObject(batchRoot!, true)).toHaveLength(0);

    // Without the opt-in a proxy is invisible to the raycaster — this is the
    // coupling `picker.ts` pays for, and the reason it calls `enableAll()`.
    const strict = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(0, 0, -1),
    );
    expect(strict.intersectObjects(roots, true)).toHaveLength(0);
  });

  it("gives a selected object its own draw call back", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));
    const [batch] = batches(runtime);

    runtime.select(["box-1"]);
    expect(batch!.count).toBe(2);
    expect((runtime.getObjectById("box-1") as THREE.Mesh).layers.mask).toBe(1);

    runtime.clearSelection();
    expect(batch!.count).toBe(3);
    expect((runtime.getObjectById("box-1") as THREE.Mesh).layers.mask).toBe(
      1 << BATCH_PROXY_LAYER,
    );
  });

  it("evicts an object that gets a per-object material, and takes it back", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));
    const [batch] = batches(runtime);

    runtime.setMaterial("box-0", { color: "#ff0000" });
    expect(batch!.count).toBe(2);

    runtime.setMaterial("box-0", undefined);
    expect(batch!.count).toBe(3);
  });

  it("shrinks with a removal and survives a reload", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));
    runtime.removeObject("box-1");
    expect(batches(runtime)[0]!.count).toBe(2);

    await runtime.loadDocument(boxes(2));
    expect(batches(runtime)).toHaveLength(1);
    expect(batches(runtime)[0]!.count).toBe(2);
    // No orphan batch root left behind by the first document.
    expect(runtime.scene.children.filter((child) => child.name === "scene-batches")).toHaveLength(1);
  });

  it("moves batched children when their group is transformed", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument({
      schemaVersion: SCHEMA_VERSION,
      sceneId: "nested",
      revision: 0,
      objects: [
        {
          id: "group",
          type: "group",
          name: "Group",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        {
          id: "child-a",
          type: "mesh",
          name: "A",
          parentId: "group",
          position: [-1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        {
          id: "child-b",
          type: "mesh",
          name: "B",
          parentId: "group",
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
      view: createDefaultViewState(),
    } as SceneDocument);

    const [batch] = batches(runtime);
    expect(batch!.count).toBe(2);

    // One frame, no renderer pass to refresh matrices: the batcher has to
    // recompute the subtree itself, or the children stay behind their group.
    runtime.applyTransform("group", {
      position: [5, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });

    const matrix = new THREE.Matrix4();
    const xs = [0, 1].map((i) => {
      batch!.getMatrixAt(i, matrix);
      return matrix.elements[12];
    });
    expect(xs.sort((a, b) => a! - b!)).toEqual([4, 6]);
  });

  it("can be switched off entirely", async () => {
    const runtime = makeRuntime({ instancing: false });
    await runtime.loadDocument(boxes(3));

    expect(batches(runtime)).toHaveLength(0);
    for (const child of runtime.scene.children) {
      if ((child as THREE.Mesh).isMesh) expect(child.layers.mask).toBe(1);
    }
  });

  it("flips batching on and off without reloading the document", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(boxes(3));
    expect(batches(runtime)[0]!.count).toBe(3);

    runtime.setInstancing(false);
    expect(batches(runtime)).toHaveLength(0);
    // Every object draws itself again, and the batch root is gone with it.
    for (const id of ["box-0", "box-1", "box-2"]) {
      expect((runtime.getObjectById(id) as THREE.Mesh).layers.mask).toBe(1);
    }
    expect(runtime.scene.children.some((child) => child.userData.sceneBatchRoot)).toBe(false);

    runtime.setInstancing(true);
    const [batch] = batches(runtime);
    expect(batch!.count).toBe(3);
    expect((runtime.getObjectById("box-1") as THREE.Mesh).layers.mask).toBe(
      1 << BATCH_PROXY_LAYER,
    );
    // Selection still outranks batching after the round trip.
    runtime.select(["box-1"]);
    expect(batch!.count).toBe(2);
  });

  it("splits a large group into cullable chunks", async () => {
    const runtime = makeRuntime();
    // 300 identical boxes → 2 chunks at the default chunk size of 256.
    await runtime.loadDocument(boxes(300));
    const chunks = batches(runtime);
    expect(chunks.map((chunk) => chunk.count)).toEqual([256, 44]);
  });
});
