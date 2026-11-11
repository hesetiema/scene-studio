// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

function stubRenderer(): RendererHandle {
  return {
    render() {},
    setSize() {},
    setPixelRatio() {},
    dispose() {},
  };
}

function makeDoc(objects: SceneDocument["objects"], sceneId = "s"): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId,
    revision: 0,
    objects,
    view: createDefaultViewState(),
  };
}

function obj(id: string, position: [number, number, number]) {
  return {
    id,
    type: "mesh" as const,
    name: id,
    position,
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function makeRuntime() {
  return new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => stubRenderer(),
    enableControls: false,
  });
}

const DTOS = [obj("a", [0, 0, 0]), obj("b", [4, 0, 0]), obj("c", [0, 3, 0])];

describe("explode", () => {
  it("offsets objects away from the scene centre, never the document", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc(DTOS));

    runtime.setExplode(0.5);
    const a = runtime.getObjectById("a")!;
    const b = runtime.getObjectById("b")!;
    const c = runtime.getObjectById("c")!;
    // Everyone moves *away* from the cluster centre (4/3, 1, 0).
    expect(a.position.x).toBeLessThan(0);
    expect(a.position.y).toBeLessThan(0);
    expect(b.position.x).toBeGreaterThan(4);
    expect(c.position.y).toBeGreaterThan(3);

    runtime.setExplode(0);
    expect(a.position.toArray()).toEqual([0, 0, 0]);
    expect(b.position.toArray()).toEqual([4, 0, 0]);
    expect(c.position.toArray()).toEqual([0, 3, 0]);
    runtime.flushDisposers();
  });

  it("clamps and reports the factor", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc(DTOS));

    expect(runtime.explode).toBe(0);
    runtime.setExplode(1.7);
    expect(runtime.explode).toBe(1);
    runtime.setExplode(-3);
    expect(runtime.explode).toBe(0);
    runtime.setExplode(Number.NaN);
    expect(runtime.explode).toBe(0);
    runtime.flushDisposers();
  });

  it("resets to the new document's positions on load", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc(DTOS));
    runtime.setExplode(1);

    await runtime.loadDocument(makeDoc([obj("x", [10, 0, 0])], "s2"));
    expect(runtime.explode).toBe(0);
    expect(runtime.getObjectById("x")!.position.toArray()).toEqual([10, 0, 0]);
    runtime.flushDisposers();
  });

  it("refreshes instance matrices for batched objects", async () => {
    const runtime = makeRuntime();
    const many = Array.from({ length: 6 }, (_, i) => obj(`o${i}`, [i * 2, 0, 0]));
    await runtime.loadDocument(makeDoc(many));

    const batchRoot = runtime.scene.children.find(
      (child) => (child as THREE.Group).userData?.sceneBatchRoot === true,
    );
    expect(batchRoot).toBeTruthy();
    const chunk = batchRoot!.children[0] as THREE.InstancedMesh;
    const before = (chunk.instanceMatrix.array as Float32Array).slice(0, 16);

    runtime.setExplode(1);
    const after = (chunk.instanceMatrix.array as Float32Array).slice(0, 16);
    expect(after.filter((value, i) => value !== before[i]).length).toBeGreaterThan(0);

    // The proxy Object3D moved (markDirty path ran through applyTransform).
    const moved = runtime.getObjectById("o0")!;
    expect(moved.position.x).toBeLessThan(0);
    runtime.flushDisposers();
  });

  it("survives an object-set change mid-preview", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc(DTOS));
    runtime.setExplode(0.5);

    await runtime.addObject(obj("d", [10, 10, 0]));
    // The rig rebuilds its baseline: everything returns to document positions
    // at factor 0, and the new object participates from the next write.
    runtime.setExplode(0);
    for (const dto of [...DTOS, obj("d", [10, 10, 0])]) {
      const object = runtime.getObjectById(dto.id)!;
      expect(object.position.toArray()).toEqual(dto.position);
    }
    runtime.flushDisposers();
  });
});
