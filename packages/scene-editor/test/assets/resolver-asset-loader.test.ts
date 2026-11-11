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

  it("reads decoders before every load, so late assignment still lands", async () => {
    const setDRACOLoader = vi.fn();
    const setKTX2Loader = vi.fn();
    const setMeshoptDecoder = vi.fn();
    const gltfLoader = stubGltf();
    Object.assign(gltfLoader, { setDRACOLoader, setKTX2Loader, setMeshoptDecoder });

    // Nothing assigned yet — the element's properties are still null.
    const decoders: { dracoLoader?: unknown; ktx2Loader?: unknown; meshoptDecoder?: unknown } = {};
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader,
      decoders: () => decoders,
    });

    // Assigned after the pipeline was built, the way a host sets them before `src`.
    decoders.dracoLoader = { kind: "draco" };
    decoders.ktx2Loader = { kind: "ktx2" };
    decoders.meshoptDecoder = { kind: "meshopt" };
    await load("a");

    expect(setDRACOLoader).toHaveBeenCalledWith({ kind: "draco" });
    expect(setKTX2Loader).toHaveBeenCalledWith({ kind: "ktx2" });
    expect(setMeshoptDecoder).toHaveBeenCalledWith({ kind: "meshopt" });
  });

  it("leaves decoders untouched when the bundle is empty", async () => {
    const setDRACOLoader = vi.fn();
    const gltfLoader = stubGltf();
    Object.assign(gltfLoader, { setDRACOLoader });

    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader,
      decoders: () => ({}),
    });
    await load("a");

    // three keeps whatever it already had; we never clear a decoder.
    expect(setDRACOLoader).not.toHaveBeenCalled();
  });

  it("pushes with-credentials onto the loader before every fetch", async () => {    const setWithCredentials = vi.fn();
    const gltfLoader = stubGltf();
    Object.assign(gltfLoader, { setWithCredentials });

    let credentials = false;
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader,
      withCredentials: () => credentials,
    });

    await load("a");
    expect(setWithCredentials).toHaveBeenLastCalledWith(false);

    // The element reads its attribute at load time, so a later toggle applies
    // to the next fetch without rebuilding the pipeline.
    credentials = true;
    await load("b");
    expect(setWithCredentials).toHaveBeenLastCalledWith(true);
  });

  it("turns a missing Draco decoder into an actionable message", async () => {
    // three's own text names an API, not a fix; the element paints this string
    // in its error slot, so it has to say what the host can actually do.
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader: {
        loadAsync: async () => {
          throw new Error("THREE.GLTFLoader: No DRACOLoader instance provided.");
        },
      },
    });

    await expect(load("compressed")).rejects.toThrow(
      /uses Draco-compressed geometry[\s\S]*decoder-path/,
    );
  });

  it("turns a missing KTX2 transcoder into an actionable message", async () => {
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader: {
        loadAsync: async () => {
          throw new Error("THREE.KTX2Loader: Missing initialization with `.detectSupport( renderer )`.");
        },
      },
    });

    await expect(load("basis")).rejects.toThrow(/uses KTX2 textures[\s\S]*basis\//);
  });

  it("leaves unrelated failures free of decoder advice", async () => {
    const load = createResolverAssetLoader({
      resolver: { resolve: async (id) => `/a/${id}.glb` },
      gltfLoader: {
        loadAsync: async () => {
          throw new Error("404 Not Found");
        },
      },
    });

    await expect(load("gone")).rejects.toThrow(/^Failed to load asset: gone$/);
  });
});
