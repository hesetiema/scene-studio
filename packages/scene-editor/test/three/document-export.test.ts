// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  createDocumentGroup,
  exportDocumentBlob,
  exportGroupBlob,
  sanitizeName,
} from "../../src/three/document-export";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { createSceneDocument } from "../../src/core/document/create";
import type { SceneDocument } from "../../src/core/document/schema";

function stubRenderer(): RendererHandle {
  return { render() {}, setSize() {}, setPixelRatio() {}, dispose() {} };
}

function mesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
}

function doc(positions: Record<string, [number, number, number]>): SceneDocument {
  return createSceneDocument({
    sceneId: "scene export test",
    objects: Object.entries(positions).map(([id, position]) => ({
      id,
      type: "mesh" as const,
      name: id,
      position,
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    baseView: createDefaultViewState(),
  });
}

describe("createDocumentGroup", () => {
  it("writes the stored transform back over live preview offsets", () => {
    const live = mesh();
    // The viewport moved it (explode / gizmo): the document still says origin.
    live.position.set(5, 5, 5);
    const group = createDocumentGroup(doc({ box: [0, 0, 0] }), {
      getObjectById: () => live,
    });

    const child = group.children[0]!;
    expect(child.position.toArray()).toEqual([0, 0, 0]);
    expect(child).not.toBe(live);
    // Shared geometry, not a copy: nothing here may be disposed.
    expect((child as THREE.Mesh).geometry).toBe((live as THREE.Mesh).geometry);
  });

  it("skips ids the runtime does not know and names the group from sceneId", () => {
    const group = createDocumentGroup(doc({ a: [1, 0, 0], b: [2, 0, 0] }), {
      getObjectById: (id) => (id === "a" ? mesh() : null),
    });

    expect(group.children).toHaveLength(1);
    expect(group.name).toBe("scene-export-test");
  });
});

describe("exportGroupBlob", () => {
  const group = createDocumentGroup(doc({ box: [0, 0, 0] }), {
    getObjectById: () => mesh(),
  });

  it("serializes GLB with the glTF magic header", async () => {
    const blob = await exportGroupBlob(group, "glb");
    const magic = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer(), 0, 4));

    expect(blob.type).toBe("model/gltf-binary");
    expect(magic).toBe("glTF");
  });

  it("serializes .gltf JSON", async () => {
    const blob = await exportGroupBlob(group, "gltf");
    const json = JSON.parse(await blob.text()) as { asset?: { version?: string } };

    expect(blob.type).toBe("model/gltf+json");
    expect(json.asset?.version).toBe("2.0");
  });

  it("serializes OBJ text with a .obj MIME so downloadBlob() picks the suffix", async () => {
    const blob = await exportGroupBlob(group, "obj");
    const text = await blob.text();

    expect(blob.type).toBe("model/obj");
    expect(text).toContain("v ");
  });
});

describe("exportDocumentBlob", () => {
  it("defaults to GLB and never touches the live objects", async () => {
    const live = mesh();
    live.position.set(9, 9, 9);
    const blob = await exportDocumentBlob(doc({ box: [0, 0, 0] }), { getObjectById: () => live });

    expect(blob.type).toBe("model/gltf-binary");
    expect(live.position.toArray()).toEqual([9, 9, 9]);
  });
});

describe("sanitizeName", () => {
  it("keeps word characters and falls back when nothing is left", () => {
    expect(sanitizeName("kitchen/scene 1", "scene")).toBe("kitchen-scene-1");
    expect(sanitizeName("///", "scene")).toBe("scene");
  });
});

describe("ThreeRuntime.exportDocument", () => {
  it("exports the loaded document through the object store", async () => {
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: () => stubRenderer(),
      enableControls: false,
    });
    const document_ = doc({ box: [0, 0, 0] });
    await runtime.loadDocument(document_);

    // Preview-only offset: must not reach the file.
    runtime.getObjectById("box")!.position.set(3, 0, 0);
    const blob = await runtime.exportDocument(document_, { format: "glb" });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(blob.type).toBe("model/gltf-binary");
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
    expect(runtime.getObjectById("box")!.position.x).toBe(3);
    runtime.flushDisposers();
  });
});
