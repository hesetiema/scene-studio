// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import type { SceneDocument } from "../../src/core/document/schema";
import { AssetCache } from "../../src/assets/asset-cache";

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

function makeRuntime(overrides?: Partial<ConstructorParameters<typeof ThreeRuntime>[0]>) {
  const renderer = stubRenderer();
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => renderer,
    enableControls: false,
    ...overrides,
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

  it("render is re-entrancy safe when orbit update re-triggers render (OrbitControls change loop)", () => {
    // Regression: real OrbitControls dispatches "change" from update(), and the
    // runtime wires that back to render() — an unguarded loop overflows the stack
    // (caught by the D10 perf bench with an externally mutated camera).
    let runtimeRef: ThreeRuntime | null = null;
    const { runtime, renderer } = makeRuntime({
      enableControls: true,
      orbitControlsFactory: () => ({
        update: () => runtimeRef?.render(),
        dispose: () => {},
      }),
      transformControlsFactory: () => ({
        addEventListener: () => {},
        removeEventListener: () => {},
        detach: () => {},
        attach: () => {},
      }),
    });
    runtimeRef = runtime;
    const rendersBefore = renderer.renders;
    expect(() => runtime.render()).not.toThrow();
    expect(renderer.renders).toBe(rendersBefore + 1);
  });

  it("select attaches transform controls to selected object; drag emits transform-commit", async () => {
    const listeners = new Map<string, (e: never) => void>();
    const detach = vi.fn();
    const attach = vi.fn();
    const commits: unknown[] = [];
    const tc = {
      addEventListener: (type: string, fn: never) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      detach,
      attach,
    };
    const { runtime } = makeRuntime({
      enableControls: true,
      orbitControlsFactory: () => ({ update: () => {}, dispose: () => {} }),
      transformControlsFactory: () => tc,
    });
    runtime.events.on("transform-commit", (payload) => commits.push(payload));
    await runtime.loadDocument(makeDoc());
    runtime.select(["box-1"]);
    expect(attach).toHaveBeenCalledTimes(1);
    // drag: mouseDown captures from, mutate, mouseUp commits
    listeners.get("mouseDown")!({} as never);
    const obj = runtime.getObjectById("box-1")!;
    obj.position.set(5, 0, 0);
    listeners.get("mouseUp")!({} as never);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      id: "box-1",
      from: { position: [1, 2, 3] },
      to: { position: [5, 0, 0] },
    });
    runtime.clearSelection();
    expect(detach).toHaveBeenCalled();
  });

  it("pick hits meshes inside an asset Group root (recursive raycast)", async () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 } as DOMRect;
    const renderer = stubRenderer();
    (renderer as RendererHandle & { domElement?: HTMLCanvasElement }).domElement = {
      getBoundingClientRect: () => rect,
    } as HTMLCanvasElement;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: () => renderer,
      enableControls: false,
      assetCache: new AssetCache(async () => ({ scene: group })),
    });
    await runtime.loadDocument({
      schemaVersion: 1,
      sceneId: "s-pick",
      revision: 0,
      objects: [
        {
          id: "asset-1",
          type: "mesh",
          name: "Asset",
          assetId: "tri",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    });
    // stub renderer never updates matrices — do what a real renderer would
    runtime.camera.updateMatrixWorld(true);
    const world = runtime.getObjectById("asset-1")!.getWorldPosition(new THREE.Vector3());
    const ndc = world.clone().project(runtime.camera);
    const clientX = ((ndc.x + 1) / 2) * rect.width;
    const clientY = ((1 - ndc.y) / 2) * rect.height;
    expect(runtime.pick(clientX, clientY)).toBe("asset-1");
  });
});
