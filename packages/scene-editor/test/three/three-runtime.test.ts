// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import type { SceneDocument } from "../../src/core/document/schema";

function stubRenderer(): RendererHandle & { disposed: boolean; renders: number } {
  return {
    disposed: false,
    renders: 0,
    render() {
      this.renders += 1;
    },
    setSize() {},
    setPixelRatio() {},
    dispose() {
      this.disposed = true;
    },
  };
}

function makeDoc(): SceneDocument {
  return {
    schemaVersion: 1,
    sceneId: "s1",
    revision: 0,
    objects: [
      {
        id: "box-1",
        type: "mesh",
        name: "Box",
        position: [1, 2, 3],
        rotation: [0, 0.5, 0],
        scale: [1, 1, 1],
      },
    ],
  };
}

function makeRuntime() {
  const renderer = stubRenderer();
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => renderer,
  });
  return { runtime, renderer };
}

describe("ThreeRuntime", () => {
  it("implements RuntimeContract with scene, camera, lights and grid", () => {
    const { runtime } = makeRuntime();
    expect(runtime.scene).toBeDefined();
    expect(runtime.camera).toBeDefined();
    expect(runtime.scene.children.length).toBeGreaterThanOrEqual(3); // ambient + directional + grid
  });

  it("loadDocument materializes objects and applies their transforms", async () => {
    const { runtime } = makeRuntime();
    await runtime.loadDocument(makeDoc());
    const obj = runtime.getObjectById("box-1");
    expect(obj).toBeDefined();
    expect(obj?.position.toArray()).toEqual([1, 2, 3]);
    expect(obj?.rotation.y).toBeCloseTo(0.5);
  });

  it("loadDocument replaces previous objects without duplicating", async () => {
    const { runtime } = makeRuntime();
    await runtime.loadDocument(makeDoc());
    await runtime.loadDocument({ ...makeDoc(), objects: [] });
    expect(runtime.getObjectById("box-1")).toBeUndefined();
  });

  it("applyTransform mutates the live object", async () => {
    const { runtime } = makeRuntime();
    await runtime.loadDocument(makeDoc());
    runtime.applyTransform("box-1", {
      position: [9, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    });
    const obj = runtime.getObjectById("box-1");
    expect(obj?.position.toArray()).toEqual([9, 0, 0]);
    expect(obj?.scale.toArray()).toEqual([2, 2, 2]);
  });

  it("select tracks ids; pick is callable and returns null by default", () => {
    const { runtime } = makeRuntime();
    runtime.select(["box-1"]);
    expect(runtime.selectedIds).toEqual(["box-1"]);
    runtime.clearSelection();
    expect(runtime.selectedIds).toEqual([]);
    expect(runtime.pick(0, 0)).toBeNull();
  });

  it("flushDisposers disposes the renderer", () => {
    const { runtime, renderer } = makeRuntime();
    runtime.flushDisposers();
    expect(renderer.disposed).toBe(true);
  });
});
