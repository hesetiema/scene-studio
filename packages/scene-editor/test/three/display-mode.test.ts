// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

function stubRenderer(): RendererHandle & { renders: number } {
  return {
    renders: 0,
    render() {
      this.renders += 1;
    },
    setSize() {},
    setPixelRatio() {},
    dispose() {},
  };
}

function makeDoc(objects: SceneDocument["objects"]): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "s",
    revision: 0,
    objects,
    view: createDefaultViewState(),
  };
}

function boxObj(id: string, position: [number, number, number] = [0, 0, 0]) {
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
  const renderer = stubRenderer();
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => renderer,
    enableControls: false,
  });
  return runtime;
}

function documentMeshes(runtime: ThreeRuntime, ids: string[]): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const id of ids) {
    runtime.getObjectById(id)?.traverse((child) => {
      if ((child as THREE.Mesh).isMesh === true) meshes.push(child as THREE.Mesh);
    });
  }
  return meshes;
}

function chunkMeshes(runtime: ThreeRuntime): THREE.Mesh[] {
  const batchRoot = runtime.scene.children.find(
    (child) => (child as THREE.Group).userData?.sceneBatchRoot === true,
  );
  if (!batchRoot) return [];
  const meshes: THREE.Mesh[] = [];
  batchRoot.traverse((child) => {
    if ((child as THREE.Mesh).isMesh === true) meshes.push(child as THREE.Mesh);
  });
  return meshes;
}

describe("display mode", () => {
  it("swaps document materials and restores them on studio", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc([boxObj("a"), boxObj("b")]));
    const originals = documentMeshes(runtime, ["a", "b"]).map((mesh) => mesh.material);

    runtime.setDisplayMode("clay");
    const clay = documentMeshes(runtime, ["a", "b"]).map((mesh) => mesh.material);
    expect(clay[0]).toBeInstanceOf(THREE.MeshStandardMaterial);
    // One shared override, not one per mesh.
    expect(clay[0]).toBe(clay[1]);
    expect(clay[0]).not.toBe(originals[0]);

    runtime.setDisplayMode("studio");
    expect(documentMeshes(runtime, ["a", "b"]).map((mesh) => mesh.material)).toEqual(originals);
    runtime.flushDisposers();
  });

  it("re-covers meshes mounted after the mode was set", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc([boxObj("a")]));
    runtime.setDisplayMode("wireframe");

    await runtime.addObject(boxObj("b"));
    const meshes = documentMeshes(runtime, ["a", "b"]);
    expect(meshes.length).toBe(2);
    expect(meshes[1]!.material).toBe(meshes[0]!.material);
    expect((meshes[1]!.material as THREE.MeshStandardMaterial).wireframe).toBe(true);
    runtime.flushDisposers();
  });

  it("covers the instancing chunks, not only the hidden proxies", async () => {
    const runtime = makeRuntime();
    const objects = Array.from({ length: 8 }, (_, i) => boxObj(`o${i}`, [i, 0, 0]));
    const ids = objects.map((dto) => dto.id);
    await runtime.loadDocument(makeDoc(objects));

    // Sanity: batching is on and chunks exist.
    expect(chunkMeshes(runtime).length).toBeGreaterThan(0);
    const proxyMaterial = documentMeshes(runtime, ids).find(
      (mesh) => mesh.userData?.sceneBatch !== true,
    )!.material;

    runtime.setDisplayMode("normal");
    const chunks = chunkMeshes(runtime);
    for (const chunk of chunks) {
      expect(chunk.material).toBeInstanceOf(THREE.MeshNormalMaterial);
    }
    // The proxies keep their override too (they draw again when de-batched).
    const proxy = documentMeshes(runtime, ids).find(
      (mesh) => mesh.userData?.sceneBatch !== true,
    )!;
    expect(proxy.material).toBeInstanceOf(THREE.MeshNormalMaterial);
    expect(proxy.material).not.toBe(proxyMaterial);

    runtime.setDisplayMode("studio");
    for (const chunk of chunkMeshes(runtime)) {
      expect(chunk.material).not.toBeInstanceOf(THREE.MeshNormalMaterial);
    }
    runtime.flushDisposers();
  });

  it("re-covers chunks rebuilt by setInstancing", async () => {
    const runtime = makeRuntime();
    await runtime.loadDocument(makeDoc([boxObj("a"), boxObj("b")]));
    runtime.setDisplayMode("clay");

    runtime.setInstancing(false);
    expect(documentMeshes(runtime, ["a", "b"]).length).toBe(2);
    runtime.setInstancing(true);
    for (const chunk of chunkMeshes(runtime)) {
      expect((chunk.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("d0d4dc");
    }
    runtime.flushDisposers();
  });

  it("reports the active mode", async () => {
    const runtime = makeRuntime();
    expect(runtime.displayMode).toBe("studio");
    runtime.setDisplayMode("xray");
    expect(runtime.displayMode).toBe("xray");
    runtime.setDisplayMode("studio");
    expect(runtime.displayMode).toBe("studio");
    runtime.flushDisposers();
  });
});
