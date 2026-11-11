import { AssetError, AssetErrorCode } from "./asset-error";
import { assetFormatHint } from "./format";
import type { AssetLoadContext, LoadedAsset } from "./asset-cache";
import {
  applyGltfDecoders,
  decoderHint,
  loadGltfScene,
  type GltfDecoders,
  type MinimalGltfLoader,
} from "./gltf-asset-loader";
import { collectMaterialVariants } from "./material-variants";

/** Host-provided URL resolution (design §10). SDK never hardcodes asset paths. */
export interface AssetResolver {
  resolve(assetId: string): Promise<string | URL>;
}

export interface ResolverAssetLoaderOptions {
  resolver: AssetResolver;
  gltfLoader?: MinimalGltfLoader;
  dracoLoader?: unknown;
  ktx2Loader?: unknown;
  /**
   * Read before every load. The element passes a getter over its own decoder
   * properties, so a host can assign a decoder after `connect` and still have
   * the next `src` load use it.
   */
  decoders?: () => GltfDecoders;
  /**
   * `with-credentials`, read before every load. three's GLTFLoader forwards the
   * flag to the FileLoaders it uses for buffers and textures, so one switch
   * covers the whole asset (model-viewer's attribute has the same scope).
   */
  withCredentials?: () => boolean;
}

/**
 * AssetLoader that: assetId → AssetResolver.resolve → glTF load.
 * Resolve failures → AssetResolveFailed; load failures → LoadFailed (D6).
 */
export function createResolverAssetLoader(options: ResolverAssetLoaderOptions) {
  const { resolver, gltfLoader } = options;
  if (gltfLoader) {
    applyGltfDecoders(gltfLoader, {
      dracoLoader: options.dracoLoader,
      ktx2Loader: options.ktx2Loader,
    });
  }

  return async function loadResolvedAsset(
    assetId: string,
    context?: AssetLoadContext,
  ): Promise<LoadedAsset> {
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

    // Blob URLs (`loadFiles`) and extension-less endpoints have no format in
    // the URL; the asset id carries it, so ask both before rejecting.
    const ext = assetFormatHint(url, assetId);
    if (ext !== "glb" && ext !== "gltf") {
      throw new AssetError(
        AssetErrorCode.UnsupportedFormat,
        `Unsupported asset format: ${ext ?? "(none)"} for ${assetId}`,
        { detail: { assetId, url, ext } },
      );
    }

    let sceneData: { scene: unknown; animations?: unknown[] };
    try {
      if (!gltfLoader) throw new Error("gltfLoader not provided");
      // Decoders can be assigned after this loader was built; re-apply each load.
      applyGltfDecoders(gltfLoader, options.decoders?.());
      // Same for credentials: the element reads its attribute at load time, so
      // toggling `with-credentials` affects the next fetch without a rebuild.
      const credentials = options.withCredentials?.();
      if (credentials !== undefined) gltfLoader.setWithCredentials?.(credentials);
      sceneData = await loadGltfScene(gltfLoader, url, context?.onProgress);
    } catch (cause) {
      const hint = decoderHint(cause);
      throw new AssetError(
        AssetErrorCode.LoadFailed,
        `Failed to load asset: ${assetId}${hint ? ` — ${hint}` : ""}`,
        {
          cause,
          detail: { assetId, url },
        },
      );
    }

    const root = sceneData.scene as {
      clone?: (recursive?: boolean) => unknown;
      isObject3D?: boolean;
      dispose?: () => void;
    };
    const asset: LoadedAsset = {
      scene: root,
      dispose: () => {
        (root as { dispose?: () => void }).dispose?.();
      },
    };
    // Forward clips: the resolver path is the one <scene-editor src> uses.
    if (sceneData.animations && sceneData.animations.length > 0) {
      asset.animations = sceneData.animations;
    }
    // KHR_materials_variants is not parsed by three; read it off the glTF JSON.
    // A host-replaced `loadGltfScene` may not hand back a parser at all.
    const variants = await collectMaterialVariants(sceneData);
    if (variants) asset.variants = variants;
    return asset;
  };
}
