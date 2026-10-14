// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { AssetCache } from "../../src/assets/asset-cache";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";

// Minimal GLTFLoader-like stub for the adapter boundary
function makeFakeGltfLoader() {
  return {
    loadAsync: vi.fn(async (url: string) => ({
      scene: { isObject3D: true, uuid: `loaded:${url}`, clone: () => ({ isObject3D: true, uuid: `clone:${url}` }) },
    })),
    setDRACOLoader: vi.fn(),
    setKTX2Loader: vi.fn(),
  };
}

describe("AssetCache (D11/D12)", () => {
  it("caches by assetId — second retain reuses the same entry", async () => {
    const load = vi.fn(async () => ({ scene: { uuid: "s" } }));
    const cache = new AssetCache(load);
    const a = await cache.retain("asset-1");
    const b = await cache.retain("asset-1");
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refcount increments on retain and decrements on release; evicts at 0", async () => {
    const load = vi.fn(async () => ({ scene: { uuid: "s" } }));
    const cache = new AssetCache(load);
    await cache.retain("asset-1");
    await cache.retain("asset-1");
    cache.release("asset-1");
    expect(cache.has("asset-1")).toBe(true);
    cache.release("asset-1");
    expect(cache.has("asset-1")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reload after eviction hits the loader again", async () => {
    const load = vi.fn(async () => ({ scene: { uuid: "s" } }));
    const cache = new AssetCache(load);
    await cache.retain("asset-1");
    cache.release("asset-1");
    await cache.retain("asset-1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("parallel retain of same id collapses to one load", async () => {
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { scene: { uuid: "s" } };
    });
    const cache = new AssetCache(load);
    const [a, b] = await Promise.all([cache.retain("asset-1"), cache.retain("asset-1")]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clear() drops everything", async () => {
    const load = vi.fn(async () => ({ scene: { uuid: "s" } }));
    const cache = new AssetCache(load);
    await cache.retain("asset-1");
    cache.clear();
    expect(cache.has("asset-1")).toBe(false);
  });
});

describe("AssetError (D6)", () => {
  it("carries AssetErrorCode and assetId detail", () => {
    const err = new AssetError(AssetErrorCode.LoadFailed, "load failed", {
      detail: { assetId: "a1", url: "/a.gltf" },
    });
    expect(err.name).toBe("SceneEditorAssetError");
    expect(err.code).toBe(AssetErrorCode.LoadFailed);
    expect(err.detail).toMatchObject({ assetId: "a1" });
  });
});
