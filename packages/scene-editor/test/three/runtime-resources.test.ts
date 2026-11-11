// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
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

function docWith(objects: SceneDocument["objects"]): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "resources",
    revision: 0,
    objects,
    view: createDefaultViewState(),
  };
}

function box(id: string, x: number): NonNullable<SceneDocument["objects"]>[number] {
  return {
    id,
    type: "mesh" as const,
    name: id,
    position: [x, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

describe("runtime shared resources", () => {
  it("allocates one buffer and one material for a field of identical boxes", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(docWith([box("a", 0), box("b", 2), box("c", 4), box("d", 6)]));

    // Four objects, two resources: geometry and base material are shared.
    expect(runtime.resourceStats).toEqual({ geometries: 1, materials: 1, references: 8 });
    // …and every proxy still points at its own transform.
    expect(runtime.getObjectById("d")?.position.x).toBe(6);
    runtime.flushDisposers();
  });

  it("keeps primitive kinds apart", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(
      docWith([
        box("a", 0),
        {
          id: "b",
          type: "primitive",
          name: "Sphere",
          position: [2, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          geometry: { kind: "sphere", radius: 1 },
        },
      ]),
    );

    expect(runtime.resourceStats.geometries).toBe(2);
    runtime.flushDisposers();
  });

  it("frees everything on teardown", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(docWith([box("a", 0), box("b", 2)]));
    expect(runtime.resourceStats.references).toBe(4);

    runtime.flushDisposers();
    expect(runtime.resourceStats).toEqual({ geometries: 0, materials: 0, references: 0 });
  });

  it("releases the previous document before loading the next one", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(docWith([box("a", 0), box("b", 2)]));
    await runtime.loadDocument(docWith([box("c", 0)]));

    // The two old objects released, the new one holds a fresh reference pair.
    expect(runtime.resourceStats).toEqual({ geometries: 1, materials: 1, references: 2 });
    runtime.flushDisposers();
  });

  it("leaves a host-supplied pool alive across teardown", async () => {
    const { createSharedResourcePool } = await import(
      "../../src/three/viewer/shared-resources"
    );
    const resources = createSharedResourcePool();
    // A host-held buffer the runtime knows nothing about.
    const external = resources.geometry("external", () => new THREE.BoxGeometry());
    const runtime = makeRuntime({ resources });
    await runtime.loadDocument(docWith([box("a", 0)]));

    runtime.flushDisposers();

    // The runtime must not dispose what it does not own.
    expect(resources.stats()).toEqual({ geometries: 1, materials: 0, references: 1 });
    resources.release(external);
    resources.dispose();
  });
});
