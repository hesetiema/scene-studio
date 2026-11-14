import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AssetCache, type LoadedAsset } from "../../src/assets/asset-cache";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";
import { MATERIAL_VARIANT_KEY } from "../../src/assets/material-variants";
import { createObjectStore, type ObjectBatcher, type ObjectStoreOptions } from "../../src/three/viewer/object-store";
import { createSharedResourcePool } from "../../src/three/viewer/shared-resources";
import { sceneDocument, sceneObject } from "../support/documents";

/**
 * Characterisation tests for the object store — the id → `Object3D` registry
 * that owns mounting, parenting, material overrides, variants and teardown.
 *
 * No renderer is involved: every behaviour here is scene-graph or refcount
 * bookkeeping, so it is observable in node. These are the net for the refactor
 * that has not happened yet — they pin *contracts*, not private helpers.
 */

function makeStore(overrides: Partial<ObjectStoreOptions> = {}) {
  const scene = new THREE.Scene();
  const errors: Array<{ error: unknown; objectId: string }> = [];
  const mounted: string[] = [];
  const store = createObjectStore({
    scene,
    assetCache: null,
    onAssetError: (error, dto) => errors.push({ error, objectId: dto.id }),
    onAssetMounted: (info) => mounted.push(info.objectId),
    ...overrides,
  });
  return { scene, store, errors, mounted };
}

interface AssetFixture {
  asset: LoadedAsset;
  root: THREE.Group;
  mesh: THREE.Mesh;
  base: THREE.MeshStandardMaterial;
  variant?: THREE.MeshStandardMaterial;
}

/** A one-mesh asset; `variants` adds a `KHR_materials_variants` table. */
function assetFixture(options: { variants?: boolean } = {}): AssetFixture {
  const base = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), base);
  const root = new THREE.Group();
  root.name = "asset-root";
  root.add(mesh);

  const asset: LoadedAsset = { scene: root, animations: [] };
  if (!options.variants) return { asset, root, mesh, base };

  const variant = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  mesh.userData[MATERIAL_VARIANT_KEY] = "0:0";
  asset.variants = {
    names: ["Red"],
    tables: new Map([["0:0", { base, byName: new Map([["Red", variant]]) }]]),
  };
  return { asset, root, mesh, base, variant };
}

/** Real cache over a fixture table, so refcounting is exercised, not mocked. */
function cacheFor(assets: Record<string, LoadedAsset>) {
  const disposed: string[] = [];
  for (const [assetId, asset] of Object.entries(assets)) {
    asset.dispose = () => disposed.push(assetId);
  }
  const cache = new AssetCache(async (assetId) => {
    const asset = assets[assetId];
    if (!asset) {
      throw new AssetError(AssetErrorCode.NotFound, `no fixture for ${assetId}`, {
        detail: { assetId },
      });
    }
    return asset;
  });
  return { cache, disposed };
}

function spyBatcher() {
  const calls: string[] = [];
  const batcher: ObjectBatcher = {
    admit: (id) => {
      calls.push(`admit:${id}`);
      return true;
    },
    exclude: (id) => {
      calls.push(`exclude:${id}`);
    },
    detach: (id) => {
      calls.push(`detach:${id}`);
    },
    markDirty: () => {
      calls.push("dirty");
    },
    clear: () => {
      calls.push("clear");
    },
  };
  return { batcher, calls };
}

describe("local objects", () => {
  it("mounts an asset-less mesh as a box placeholder, flagged as a caster", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject());
    const object = store.get("obj-1") as THREE.Mesh;

    expect(store.size).toBe(1);
    expect(object).toBeInstanceOf(THREE.Mesh);
    expect(object.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect(object.parent).toBe(scene);
    // Opt-in per mesh: the contact-shadow plane only sees these.
    expect(object.castShadow).toBe(true);
    // Default layer, so the main camera draws it until a batcher says otherwise.
    expect(object.layers.mask).toBe(1);
    // Picking contract: root and every child carry the document id.
    expect(object.userData.objectId).toBe("obj-1");
    expect(object.userData.sceneObjectId).toBe("obj-1");
  });

  it("builds a primitive from the document geometry and transform", async () => {
    const { store } = makeStore();
    await store.add(
      sceneObject({
        type: "primitive",
        geometry: { kind: "box", width: 2, height: 1, depth: 4 },
        position: [1, 2, 3],
      }),
    );
    const object = store.get("obj-1") as THREE.Mesh;
    object.geometry.computeBoundingBox();
    const size = object.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.toArray()).toEqual([2, 1, 4]);
    expect(object.position.toArray()).toEqual([1, 2, 3]);
  });

  it("is idempotent by id, so a redo does not mount twice", async () => {
    const { store } = makeStore();
    await store.add(sceneObject());
    const first = store.get("obj-1");
    await store.add(sceneObject());
    expect(store.size).toBe(1);
    expect(store.get("obj-1")).toBe(first);
  });

  it("parents a child under its declared parent", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject({ id: "group", type: "group", name: "G" }));
    await store.add(sceneObject({ id: "child", parentId: "group" }));

    const group = store.get("group")!;
    expect(store.get("child")!.parent).toBe(group);
    expect(group.parent).toBe(scene);
    expect(store.list()).toHaveLength(2);
  });

  it("resolves nested children into their parents' world bounds", async () => {
    const { store } = makeStore();
    await store.add(sceneObject({ id: "group", type: "group" }));
    await store.add(sceneObject({ id: "child", parentId: "group", position: [10, 0, 0] }));
    const box = store.bounds();
    // The child's [10,0,0] is *local*; bounds() only starts at roots and lets
    // `expandByObject` walk down, so the world position is what lands in the box.
    expect(box.max.x).toBeCloseTo(10.5);
  });

  it("returns an empty bounds when nothing is mounted", () => {
    const { store } = makeStore();
    expect(store.bounds().isEmpty()).toBe(true);
  });
});

describe("load()", () => {
  it("replaces whatever was mounted before", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject({ id: "old" }));
    expect(scene.children).toHaveLength(1);

    await store.load(sceneDocument({ objects: [sceneObject({ id: "new" })] }));
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBeDefined();
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]!.userData.objectId).toBe("new");
  });

  it("reports one monotonic 0..1 curve and ends at 1", async () => {
    const { store } = makeStore();
    const seen: number[] = [];
    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "a" }), sceneObject({ id: "b" }), sceneObject({ id: "c" })],
      }),
      (progress) => seen.push(progress.totalProgress),
    );
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it("reports 1 immediately for an empty document", async () => {
    const { store } = makeStore();
    const seen: number[] = [];
    await store.load(sceneDocument({ objects: [] }), (progress) => seen.push(progress.totalProgress));
    expect(seen).toEqual([1]);
  });

  it("keeps loading the rest of the document when one object fails", async () => {
    const { store, errors } = makeStore();
    await store.load(
      sceneDocument({
        objects: [
          sceneObject({ id: "ok" }),
          sceneObject({ id: "broken", assetId: "missing" }),
          sceneObject({ id: "after" }),
        ],
      }),
    );
    expect(store.size).toBe(2);
    expect(store.get("ok")).toBeDefined();
    expect(store.get("after")).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.objectId).toBe("broken");
    expect((errors[0]!.error as AssetError).code).toBe(AssetErrorCode.NotFound);
  });

  it("fails loudly — not silently — when an object names an asset but there is no cache", async () => {
    const { store, errors } = makeStore();
    await store.load(sceneDocument({ objects: [sceneObject({ id: "a", assetId: "whatever" })] }));
    expect(store.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as AssetError).code).toBe(AssetErrorCode.NotFound);
  });

  it("promotes an orphan to a root instead of dropping it", async () => {
    const { scene, store } = makeStore();
    await store.load(
      sceneDocument({
        objects: [sceneObject({ id: "child", parentId: "never-mounted" })],
      }),
    );
    expect(store.get("child")!.parent).toBe(scene);
  });

  it("grows the progress bar for an unknown content length", async () => {
    const fixture = assetFixture();
    // total = 0 is the "chunked response" case: pin the asymptote, not a pin
    // at zero until the load ends.
    const cache = new AssetCache(async () => {
      return fixture.asset;
    });
    const { store } = makeStore({ assetCache: cache });
    const seen: number[] = [];
    await store.load(
      sceneDocument({ objects: [sceneObject({ id: "a", assetId: "a1" })] }),
      (progress) => seen.push(progress.totalProgress),
    );
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
  });
});

describe("assets", () => {
  it("instantiates a clone, not the cached root", async () => {
    const fixture = assetFixture();
    const { cache } = cacheFor({ a1: fixture.asset });
    const { scene, store } = makeStore({ assetCache: cache });

    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    const object = store.get("a")!;
    expect(object).not.toBe(fixture.root);
    expect(object.parent).toBe(scene);
    expect(fixture.root.parent).toBeNull();
    expect(object.userData.objectId).toBe("a");
    // `tagSceneObject` recurses: a hit on a child resolves to the object.
    const child = (object as THREE.Group).children[0]!;
    expect(child.userData.sceneObjectId).toBe("a");
  });

  it("holds one cache reference per mounted object and releases it on remove", async () => {
    const fixture = assetFixture();
    const { cache, disposed } = cacheFor({ a1: fixture.asset });
    const { store } = makeStore({ assetCache: cache });

    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    await store.add(sceneObject({ id: "b", assetId: "a1" }));
    expect(cache.refCount("a1")).toBe(2);

    store.remove("a");
    expect(cache.refCount("a1")).toBe(1);
    expect(disposed).toEqual([]);
    expect(store.get("b")).toBeDefined();

    store.remove("b");
    // Last release is what lets the loader free the GPU buffers (D12).
    expect(cache.refCount("a1")).toBe(0);
    expect(disposed).toEqual(["a1"]);
  });

  it("notifies the runtime so it can register animation clips", async () => {
    const fixture = assetFixture();
    const { cache } = cacheFor({ a1: fixture.asset });
    const { store, mounted } = makeStore({ assetCache: cache });
    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    expect(mounted).toEqual(["a"]);
  });
});

describe("material overrides", () => {
  it("clones per object and restores the original on clear", async () => {
    const { store } = makeStore();
    await store.add(sceneObject());
    const original = (store.get("obj-1") as THREE.Mesh).material as THREE.Material;

    store.setMaterial("obj-1", { color: "#ff0000" });
    const applied = (store.get("obj-1") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(applied).not.toBe(original);
    expect(applied.color.getHexString()).toBe("ff0000");
    const dispose = vi.spyOn(applied, "dispose");

    store.setMaterial("obj-1", undefined);
    expect((store.get("obj-1") as THREE.Mesh).material).toBe(original);
    expect(dispose).toHaveBeenCalled();
  });

  it("never writes through to the cached asset's material", async () => {
    const fixture = assetFixture();
    const { cache } = cacheFor({ a1: fixture.asset });
    const { store } = makeStore({ assetCache: cache });
    await store.add(sceneObject({ id: "a", assetId: "a1" }));

    store.setMaterial("a", { color: "#00ff00" });
    const instance = store.get("a") as THREE.Group;
    const mesh = instance.children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("00ff00");
    // The cached asset other objects clone from is untouched.
    expect(fixture.base.color.getHexString()).toBe("111111");
  });

  it("ignores a material on a group (groups carry no surface)", async () => {
    const { store } = makeStore();
    await store.add(
      sceneObject({ id: "group", type: "group", material: { color: "#ff0000" } }),
    );
    const group = store.get("group") as THREE.Group;
    expect(group.children).toHaveLength(0);
  });
});

describe("variants", () => {
  async function mountedVariantAsset() {
    const fixture = assetFixture({ variants: true });
    const { cache } = cacheFor({ a1: fixture.asset });
    const { store } = makeStore({ assetCache: cache });
    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    return { fixture, store };
  }

  function instanceMaterial(store: ReturnType<typeof makeStore>["store"]) {
    return ((store.get("a") as THREE.Group).children[0] as THREE.Mesh).material;
  }

  it("lists the names the mounted assets declare", async () => {
    const { store } = await mountedVariantAsset();
    expect(store.variants()).toEqual(["Red"]);
    expect(store.variantName).toBeNull();
  });

  it("swaps the material slot and restores the asset default with null", async () => {
    const { fixture, store } = await mountedVariantAsset();
    expect(store.setVariant("Red")).toBe(true);
    expect(instanceMaterial(store)).toBe(fixture.variant);
    expect(store.variantName).toBe("Red");

    expect(store.setVariant(null)).toBe(true);
    expect(instanceMaterial(store)).toBe(fixture.base);
    expect(store.variantName).toBeNull();
  });

  it("reports an unknown name as not declared, but still resets to the default", async () => {
    const { fixture, store } = await mountedVariantAsset();
    expect(store.setVariant("Nope")).toBe(false);
    expect(instanceMaterial(store)).toBe(fixture.base);
    // Remembered on purpose: a typo must be visible, not silently locked in.
    expect(store.variantName).toBe("Nope");
  });

  it("applies a variant chosen before the asset finished loading", async () => {
    const fixture = assetFixture({ variants: true });
    const { cache } = cacheFor({ a1: fixture.asset });
    const { store } = makeStore({ assetCache: cache });

    // Nothing is mounted yet, so the honest answer to "did any asset declare
    // it" is no — but the pick is remembered, and the mount path re-applies it.
    expect(store.setVariant("Red")).toBe(false);
    expect(store.variantName).toBe("Red");

    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    expect(instanceMaterial(store)).toBe(fixture.variant);
  });

  it("lets an explicit document material outrank the viewer variant", async () => {
    const { fixture, store } = await mountedVariantAsset();
    store.setMaterial("a", { color: "#00ff00" });
    store.setVariant("Red");
    const material = instanceMaterial(store) as THREE.MeshStandardMaterial;
    expect(material).not.toBe(fixture.variant);
    expect(material.color.getHexString()).toBe("00ff00");
  });
});

describe("batching decisions", () => {
  it("admits local objects once their parent is real", async () => {
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ batcher });
    await store.add(sceneObject());
    expect(calls).toEqual(["admit:obj-1"]);
  });

  it("keeps a selected object out of a batch, and re-admits it afterwards", async () => {
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ batcher });
    await store.add(sceneObject());
    calls.length = 0;

    store.setSelected(["obj-1"]);
    expect(calls).toEqual(["exclude:obj-1"]);

    // Same selection again: no churn.
    calls.length = 0;
    store.setSelected(["obj-1"]);
    expect(calls).toEqual([]);

    store.setSelected([]);
    expect(calls).toEqual(["admit:obj-1"]);
  });

  it("keeps an object with a material override out of a batch", async () => {
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ batcher });
    await store.add(sceneObject());
    calls.length = 0;

    store.setMaterial("obj-1", { color: "#ff0000" });
    expect(calls).toEqual(["exclude:obj-1"]);

    calls.length = 0;
    store.setMaterial("obj-1", undefined);
    expect(calls).toEqual(["admit:obj-1"]);
  });

  it("never batches an asset subtree (variant switches rewrite per-node materials)", async () => {
    const fixture = assetFixture({ variants: true });
    const { cache } = cacheFor({ a1: fixture.asset });
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ assetCache: cache, batcher });
    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    expect(calls).toEqual(["exclude:a"]);
  });

  it("detaches on remove and clears first on clear", async () => {
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ batcher });
    await store.add(sceneObject({ id: "a" }));
    await store.add(sceneObject({ id: "b" }));
    calls.length = 0;

    store.remove("a");
    expect(calls).toEqual(["detach:a"]);

    calls.length = 0;
    store.clear();
    // Batches hold their own clones: they must go before their members.
    expect(calls[0]).toBe("clear");
  });

  it("swap-restores layers when the strategy changes", async () => {
    const first = spyBatcher();
    const second = spyBatcher();
    const { store } = makeStore({ batcher: first.batcher });
    await store.add(sceneObject());
    first.calls.length = 0;

    store.setBatcher(second.batcher);
    // The outgoing rig is told to let go before the new one admits.
    expect(first.calls).toEqual(["exclude:obj-1"]);
    expect(second.calls).toEqual(["admit:obj-1"]);

    store.setBatcher(null);
    second.calls.length = 0;
    await store.add(sceneObject({ id: "obj-2" }));
    expect(second.calls).toEqual([]);
  });

  it("marks the subtree dirty on reparent and on transform", async () => {
    const { batcher, calls } = spyBatcher();
    const { store } = makeStore({ batcher });
    await store.add(sceneObject({ id: "group", type: "group" }));
    await store.add(sceneObject({ id: "child", parentId: "group" }));
    calls.length = 0;

    store.reparent("child", undefined);
    expect(calls).toEqual(["dirty"]);

    calls.length = 0;
    expect(store.applyTransform("child", { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] })).toBe(true);
    expect(calls).toEqual(["dirty"]);
  });
});

describe("reparent", () => {
  it("moves a child to the scene root and back under a group", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject({ id: "group", type: "group" }));
    await store.add(sceneObject({ id: "child", parentId: "group" }));

    store.reparent("child", undefined);
    expect(store.get("child")!.parent).toBe(scene);

    store.reparent("child", "group");
    expect(store.get("child")!.parent).toBe(store.get("group"));
  });

  it("refuses a cycle by promoting the object to a root", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject({ id: "group", type: "group" }));
    await store.add(sceneObject({ id: "child", parentId: "group" }));

    // Making the group a child of its own child would close a loop.
    store.reparent("group", "child");
    expect(store.get("group")!.parent).toBe(scene);
    expect(store.get("child")!.parent).toBe(store.get("group"));
  });

  it("is a no-op for an unknown id", () => {
    const { store } = makeStore();
    expect(() => store.reparent("nope", undefined)).not.toThrow();
  });
});

describe("transform", () => {
  it("writes position, rotation and scale", async () => {
    const { store } = makeStore();
    await store.add(sceneObject());
    const object = store.get("obj-1")!;
    store.applyTransform("obj-1", {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    });
    expect(object.position.toArray()).toEqual([1, 2, 3]);
    expect(object.scale.toArray()).toEqual([2, 2, 2]);
    expect(object.rotation.x).toBeCloseTo(0.1);
  });

  it("returns false for an unknown id", () => {
    const { store } = makeStore();
    expect(
      store.applyTransform("nope", { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    ).toBe(false);
  });
});

describe("teardown", () => {
  it("releases pooled placeholder resources back to the pool", async () => {
    const { store } = makeStore();
    await store.add(sceneObject({ id: "a" }));
    await store.add(sceneObject({ id: "b" }));
    // One geometry + one base material shared by both placeholders.
    expect(store.resources()).toMatchObject({ geometries: 1, materials: 1 });

    store.clear();
    expect(store.size).toBe(0);
    expect(store.resources()).toMatchObject({ geometries: 0, materials: 0, references: 0 });
  });

  it("returns a caller-supplied pool intact", async () => {
    const pool = createSharedResourcePool();
    const { store } = makeStore({ resources: pool });
    await store.add(sceneObject());
    store.dispose();
    // Not this store's pool to destroy — it released its references only.
    expect(pool.stats()).toMatchObject({ geometries: 0, materials: 0, references: 0 });
  });

  it("empties the scene and disposes the override clones", async () => {
    const { scene, store } = makeStore();
    await store.add(sceneObject({ id: "a" }));
    store.setMaterial("a", { color: "#ff0000" });
    const clone = (store.get("a") as THREE.Mesh).material as THREE.Material;
    const dispose = vi.spyOn(clone, "dispose");

    store.dispose();
    expect(scene.children).toHaveLength(0);
    expect(store.size).toBe(0);
    // Teardown restores the original material, which is what disposes the clone.
    expect(dispose).toHaveBeenCalled();
  });

  it("survives a teardown that throws", async () => {
    const fixture = assetFixture();
    fixture.asset.dispose = () => {
      throw new Error("loader dispose failed");
    };
    const { cache } = cacheFor({ a1: fixture.asset });
    const { store } = makeStore({ assetCache: cache });
    await store.add(sceneObject({ id: "a", assetId: "a1" }));
    expect(() => store.dispose()).not.toThrow();
    expect(store.size).toBe(0);
  });
});
