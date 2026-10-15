import { AssetError, AssetErrorCode } from "./asset-error";
import type { LoadedAsset } from "./asset-cache";
import type { MinimalGltfLoader } from "./gltf-asset-loader";

/** Host-provided URL resolution (design §10). SDK never hardcodes asset paths. */
export interface AssetResolver {
  resolve(assetId: string): Promise<string | URL>;
}

export interface ResolverAssetLoaderOptions {
  resolver: AssetResolver;
  gltfLoader: MinimalGltfLoader;
  dracoLoader?: unknown;
  ktx2Loader?: unknown;
}

/**
 * AssetLoader that: assetId → AssetResolver.resolve → glTF load.
 * Resolve failures → AssetResolveFailed; load failures → LoadFailed (D6).
 */
export function createResolverAssetLoader(options: ResolverAssetLoaderOptions) {
  const { resolver, gltfLoader } = options;
  if (options.dracoLoader) gltfLoader.setDRACOLoader?.(options.dracoLoader);
  if (options.ktx2Loader) gltfLoader.setKTX2Loader?.(options.ktx2Loader);

  return async function loadResolvedAsset(assetId: string): Promise<LoadedAsset> {
    let url: string;
    try {
      const resolved = await resolver.resolve(assetId);
      url = typeof resolved === "string" ? resolved : resolved.href;
    } catch (cause) {
      throw new AssetError(
        AssetErrorCode.ResolveFailed,
        `Failed to resolve asset: ${assetId}`,
        { cause, detail: { assetId } },
      );
    }

    const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase();
    if (ext !== "glb" && ext !== "gltf") {
      throw new AssetError(
        AssetErrorCode.UnsupportedFormat,
        `Unsupported asset format: ${ext ?? "(none)"} for ${assetId}`,
        { detail: { assetId, url, ext } },
      );
    }

    let sceneData: { scene: unknown };
    try {
      sceneData = await gltfLoader.loadAsync(url);
    } catch (cause) {
      throw new AssetError(AssetErrorCode.LoadFailed, `Failed to load asset: ${assetId}`, {
        cause,
        detail: { assetId, url },
      });
    }

    const root = sceneData.scene as {
      clone?: (recursive?: boolean) => unknown;
      isObject3D?: boolean;
      dispose?: () => void;
    };
    return {
      scene: root,
      dispose: () => {
        (root as { dispose?: () => void }).dispose?.();
      },
    };
  };
}
