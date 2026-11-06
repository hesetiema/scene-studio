import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createObjectStore } from "../../src/three/viewer/object-store";
import { AssetCache } from "../../src/assets/asset-cache";
import type { SceneObjectDTO } from "../../src/core/document/schema";
import { sceneDocument, sceneObject } from "../support/documents";

function groupObject(overrides: Partial<SceneObjectDTO> = {}): SceneObjectDTO {
  return sceneObject({ id: "grp", name: "Group", type: "group", ...overrides });
}

function makeStore() {
  const scene = new THREE.Scene();
  const store = createObjectStore({
    scene,
    assetCache: null,
    onAssetError: () => {},
  });
  return { scene, store };
}

function worldPosition(object: THREE.Object3D): THREE.Vector3 {
  return object.getWorldPosition(new THREE.Vector3());
}

describe("object store: groups", () => {
  it("mounts a group object as a real THREE.Group", async () => {
    const { scene, store } = makeStore();

    await store.load(sceneDocument({ objects: [groupObject()] }));

    const group = store.get("grp");
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group?.parent).toBe(scene);
    expect(group?.name).toBe("Group");
  });

  it("parents children under their group instead of the scene", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [groupObject(), sceneObject({ id: "child", parentId: "grp" })],
      }),
    );

    expect(store.get("child")?.parent).toBe(store.get("grp"));
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]).toBe(store.get("grp"));
  });

  it("resolves a child listed before its parent", async () => {
    const { store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "child", parentId: "grp" }), groupObject()],
      }),
    );

    expect(store.get("child")?.parent).toBe(store.get("grp"));
  });

  it("composes transforms through the hierarchy", async () => {
    const { store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [
          groupObject({ position: [2, 0, 0] }),
          sceneObject({ id: "child", parentId: "grp", position: [0, 1, 0] }),
        ],
      }),
    );

    expect(worldPosition(store.get("child")!).toArray()).toEqual([2, 1, 0]);
  });

  it("moves children when the group is transformed", async () => {
    const { store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [groupObject(), sceneObject({ id: "child", parentId: "grp" })],
      }),
    );

    const moved = store.applyTransform("grp", {
      position: [5, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });

    expect(moved).toBe(true);
    expect(worldPosition(store.get("child")!).toArray()).toEqual([5, 0, 0]);
  });

  it("promotes a child whose parent is missing to a root", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({ objects: [sceneObject({ id: "child", parentId: "ghost" })] }),
    );

    expect(store.get("child")?.parent).toBe(scene);
    expect(scene.children).toHaveLength(1);
  });

  it("breaks a parent cycle instead of hanging or losing objects", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "a", parentId: "b" }), sceneObject({ id: "b", parentId: "a" })],
      }),
    );

    const a = store.get("a")!;
    const b = store.get("b")!;
    // One direction wins, the other is demoted to a root: no cycle, nothing lost.
    expect(a.parent === b || b.parent === a).toBe(true);
    expect(scene.getObjectById(a.id)).toBe(a);
    expect(scene.getObjectById(b.id)).toBe(b);
  });

  it("detaches children when the store is cleared", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [groupObject(), sceneObject({ id: "child", parentId: "grp" })],
      }),
    );
    store.clear();

    expect(scene.children).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(store.get("child")).toBeUndefined();
  });

  it("reloads a document without leaking the previous hierarchy", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [groupObject(), sceneObject({ id: "child", parentId: "grp" })],
      }),
    );
    await store.load(sceneDocument({ objects: [groupObject({ id: "grp-2" })] }));

    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]?.name).toBe("Group");
    expect(store.get("child")).toBeUndefined();
  });
});

describe("object store: primitives", () => {
  it("mounts a primitive with the declared geometry and material", async () => {
    const { scene, store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [
          sceneObject({
            id: "prim",
            type: "primitive",
            geometry: { kind: "sphere", radius: 2 },
            material: { color: "#00ff00" },
          }),
        ],
      }),
    );

    const mesh = store.get("prim") as THREE.Mesh;
    expect(mesh.isMesh).toBe(true);
    expect(mesh.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("00ff00");
    expect(scene.children).toHaveLength(1);

    store.clear();
    expect(scene.children).toHaveLength(0);
  });

  it("parents a primitive like any other object", async () => {
    const { store } = makeStore();

    await store.load(
      sceneDocument({
        objects: [
          groupObject(),
          sceneObject({ id: "prim", type: "primitive", geometry: { kind: "box" }, parentId: "grp" }),
        ],
      }),
    );

    expect(store.get("prim")?.parent).toBe(store.get("grp"));
  });
});

describe("object store: material overrides on assets", () => {  it("repaints the instance without touching the cached material", async () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const assetRoot = new THREE.Group();
    assetRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));

    const scene = new THREE.Scene();
    const store = createObjectStore({
      scene,
      assetCache: new AssetCache(async () => ({ scene: assetRoot })),
      onAssetError: () => {},
    });

    await store.load(
      sceneDocument({
        objects: [
          sceneObject({ id: "asset-obj", assetId: "a1", material: { color: "#ff0000" } }),
        ],
      }),
    );

    const mounted = store.get("asset-obj")!;
    let checked = 0;
    mounted.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      checked += 1;
      expect(mesh.material).not.toBe(shared);
      expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("ff0000");
    });

    expect(checked).toBe(1);
    // The cache still owns the original material, untouched.
    expect(shared.color.getHexString()).toBe("ffffff");

    store.clear();
  });
});

describe("object store: incremental editing", () => {
  it("adds objects one at a time, including under a parent", async () => {
    const { scene, store } = makeStore();

    await store.add(sceneObject({ id: "grp", type: "group" }));
    await store.add(
      sceneObject({ id: "prim", type: "primitive", geometry: { kind: "sphere" }, parentId: "grp" }),
    );

    expect(store.size).toBe(2);
    expect(scene.children).toEqual([store.get("grp")]);
    expect(store.get("prim")?.parent).toBe(store.get("grp"));
  });

  it("is idempotent by id so a redo cannot double-mount", async () => {
    const { store } = makeStore();
    const dto = sceneObject({ id: "grp", type: "group" });

    await store.add(dto);
    await store.add(dto);

    expect(store.size).toBe(1);
  });

  it("removes exactly one object without touching its siblings", async () => {
    const { scene, store } = makeStore();
    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "a" }), sceneObject({ id: "b" })],
      }),
    );

    store.remove("a");

    expect(store.size).toBe(1);
    expect(store.get("a")).toBeUndefined();
    expect(scene.children).toHaveLength(1);

    store.remove("ghost");
    expect(store.size).toBe(1);
  });

  it("reparents a live object and back to the root", async () => {
    const { scene, store } = makeStore();
    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "grp", type: "group" }), sceneObject({ id: "box" })],
      }),
    );

    store.reparent("box", "grp");
    expect(store.get("box")?.parent).toBe(store.get("grp"));

    store.reparent("box", undefined);
    expect(store.get("box")?.parent).toBe(scene);
  });

  it("replaces and clears a material override, restoring the original", async () => {
    const { store } = makeStore();
    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "prim", type: "primitive", geometry: { kind: "box" } })],
      }),
    );

    const mesh = store.get("prim") as THREE.Mesh;
    const original = mesh.material as THREE.MeshStandardMaterial;
    expect(original.color.getHexString()).toBe("4f8ef7");

    store.setMaterial("prim", { color: "#ff0000" });
    const painted = mesh.material as THREE.MeshStandardMaterial;
    expect(painted).not.toBe(original);
    expect(painted.color.getHexString()).toBe("ff0000");

    store.setMaterial("prim", { color: "#00ff00" });
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("00ff00");

    store.setMaterial("prim", undefined);
    expect(mesh.material).toBe(original);
    expect(original.color.getHexString()).toBe("4f8ef7");
  });
});
