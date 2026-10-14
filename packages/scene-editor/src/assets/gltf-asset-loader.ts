import { AssetError, AssetErrorCode } from "./asset-error";
import type { LoadedAsset } from "./asset-cache";

/**
 * glTF/GLB loader adapter (D16). The SDK depends on a narrow structural
 * interface so three's GLTFLoader (or a test stub) can be injected without
 * the core importing three directly.
 */
export interface MinimalGltfLoader {
  loadAsync(url: string): Promise<{ scene: unknown }>;
  setDRACOLoader?(loader: unknown): void;
  setKTX2Loader?(loader: unknown): void;
}

export interface GltfAssetLoaderOptions {
  /** Base URL or map function resolving assetId → URL. */
  resolveUrl: (assetId: string) => string;
  /** Injected GLTFLoader-like instance (three's GLTFLoader or a stub). */
  gltfLoader: MinimalGltfLoader;
  dracoLoader?: unknown;
  ktx2Loader?: unknown;
}

/** Supported format matrix (D16). Draco/KTX2 are optional enhancers, not required. */
export const SUPPORTED_ASSET_FORMATS = ["glb", "gltf"] as const;

export function createGltfAssetLoader(options: GltfAssetLoaderOptions) {
  const { resolveUrl, gltfLoader } = options;
  if (options.dracoLoader) gltfLoader.setDRACOLoader?.(options.dracoLoader);
  if (options.ktx2Loader) gltfLoader.setKTX2Loader?.(options.ktx2Loader);

  return async function loadGltfAsset(assetId: string): Promise<LoadedAsset> {
    const url = resolveUrl(assetId);
    const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase();
    if (ext !== "glb" && ext !== "gltf") {
      throw new AssetError(
        AssetErrorCode.UnsupportedFormat,
        `Unsupported asset format: ${ext ?? "(none)"} (supported: ${SUPPORTED_ASSET_FORMATS.join(", ")})`,
        { detail: { assetId, url, ext } },
      );
    }
    let sceneData: { scene: unknown };
    try {
      sceneData = await gltfLoader.loadAsync(url);
    } catch (cause) {
      throw new AssetError(AssetErrorCode.LoadFailed, `Failed to load glTF asset: ${assetId}`, {
        cause,
        detail: { assetId, url },
      });
    }
    const root = sceneData.scene as { clone?: () => unknown; isObject3D?: boolean };
    return {
      scene: root,
      dispose: () => {
        // three GLTFLoader has no dispose; the runtime disposes geometries/materials
        // when the owning object is removed. Here we only guard optional hooks.
        (root as { dispose?: () => void }).dispose?.();
      },
    };
  };
}
