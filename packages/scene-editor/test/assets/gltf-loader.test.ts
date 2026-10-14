import { describe, expect, it, vi } from "vitest";
import { createGltfAssetLoader } from "../../src/assets/gltf-asset-loader";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";
import type { MinimalGltfLoader } from "../../src/assets/gltf-asset-loader";

function stubLoader(overrides?: Partial<MinimalGltfLoader>): MinimalGltfLoader {
  return {
    loadAsync: vi.fn(async (url: string) => ({
      scene: { isObject3D: true, uuid: url, clone: () => ({ uuid: `clone:${url}` }) },
    })),
    ...overrides,
  };
}

describe("createGltfAssetLoader (D16)", () => {
  it("loads .glb and .gltf URLs", async () => {
    const gltfLoader = stubLoader();
    const load = createGltfAssetLoader({
      resolveUrl: (id) => `/assets/${id}.glb`,
      gltfLoader,
    });
    const a = await load("model-1");
    expect(a.scene).toBeDefined();
    expect(gltfLoader.loadAsync).toHaveBeenCalledWith("/assets/model-1.glb");

    const loadGltf = createGltfAssetLoader({
      resolveUrl: (id) => `/assets/${id}.gltf`,
      gltfLoader: stubLoader(),
    });
    await expect(loadGltf("m")).resolves.toBeDefined();
  });

  it("rejects unsupported formats with AssetErrorCode.UnsupportedFormat", async () => {
    const load = createGltfAssetLoader({
      resolveUrl: () => "/assets/x.fbx",
      gltfLoader: stubLoader(),
    });
    try {
      await load("x");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AssetError);
      expect((err as AssetError).code).toBe(AssetErrorCode.UnsupportedFormat);
    }
  });

  it("wires optional draco/ktx2 loaders onto the gltf loader", () => {
    const setDRACOLoader = vi.fn();
    const setKTX2Loader = vi.fn();
    createGltfAssetLoader({
      resolveUrl: (id) => `${id}.glb`,
      gltfLoader: stubLoader({ setDRACOLoader, setKTX2Loader }),
      dracoLoader: { kind: "draco" },
      ktx2Loader: { kind: "ktx2" },
    });
    expect(setDRACOLoader).toHaveBeenCalledWith({ kind: "draco" });
    expect(setKTX2Loader).toHaveBeenCalledWith({ kind: "ktx2" });
  });

  it("propagates loader failure as AssetError.LoadFailed", async () => {
    const gltfLoader = stubLoader({
      loadAsync: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const load = createGltfAssetLoader({
      resolveUrl: () => "/a.glb",
      gltfLoader,
    });
    try {
      await load("a");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as AssetError).code).toBe(AssetErrorCode.LoadFailed);
    }
  });
});
