// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createResolverAssetLoader } from "../../src/assets/resolver-asset-loader";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";
import type { MinimalGltfLoader } from "../../src/assets/gltf-asset-loader";

function stubGltf(name = "m"): MinimalGltfLoader {
  return {
    loadAsync: vi.fn(async (url: string) => ({
      scene: {
        isObject3D: true,
        uuid: `${name}:${url}`,
        clone: () => ({ isObject3D: true, uuid: `clone:${name}:${url}` }),
      },
    })),
  };
}

describe("createResolverAssetLoader (AssetResolver contract)", () => {
  it("resolves assetId → URL then loads glTF", async () => {
    const resolve = vi.fn(async (id: string) => `https://cdn.example/${id}.glb`);
    const gltfLoader = stubGltf();
    const load = createResolverAssetLoader({ resolver: { resolve }, gltfLoader });
    const asset = await load("hero");
    expect(resolve).toHaveBeenCalledWith("hero");
    expect(gltfLoader.loadAsync).toHaveBeenCalledWith("https://cdn.example/hero.glb");
    expect(asset.scene).toBeDefined();
  });

  it("accepts URL objects from resolver", async () => {
    const gltfLoader = stubGltf();
    const load = createResolverAssetLoader({
      resolver: { resolve: async () => new URL("https://cdn.example/x.gltf") },
      gltfLoader,
    });
    await load("x");
    expect(gltfLoader.loadAsync).toHaveBeenCalledWith("https://cdn.example/x.gltf");
  });

  it("wraps resolver failure as AssetErrorCode.AssetResolveFailed", async () => {
    const load = createResolverAssetLoader({
      resolver: {
        resolve: async () => {
          throw new Error("403");
        },
      },
      gltfLoader: stubGltf(),
    });
    try {
      await load("secret");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AssetError);
      expect((err as AssetError).code).toBe(AssetErrorCode.ResolveFailed);
      expect((err as AssetError).detail).toMatchObject({ assetId: "secret" });
    }
  });

  it("wraps glTF load failure as AssetErrorCode.LoadFailed", async () => {
    const gltfLoader: MinimalGltfLoader = {
      loadAsync: async () => {
        throw new Error("network");
      },
    };
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
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
