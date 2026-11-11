import { AssetError, AssetErrorCode } from "./asset-error";
import { assetFormatHint } from "./format";
import type { AssetLoadContext, AssetLoadProgress, LoadedAsset } from "./asset-cache";

/**
 * glTF/GLB loader adapter (D16). The SDK depends on a narrow structural
 * interface so three's GLTFLoader (or a test stub) can be injected without
 * the core importing three directly.
 *
 * `load` is optional: when present (three's GLTFLoader has it) the adapter can
 * report byte progress; otherwise it falls back to `loadAsync` with no progress.
 */
export interface MinimalGltfLoader {
  loadAsync(url: string): Promise<{ scene: unknown; animations?: unknown[] }>;
  load?(
    url: string,
    onLoad: (data: { scene: unknown; animations?: unknown[] }) => void,
    onProgress?: (event: { loaded: number; total: number }) => void,
    onError?: (error: unknown) => void,
  ): unknown;
  setDRACOLoader?(loader: unknown): void;
  setKTX2Loader?(loader: unknown): void;
  setMeshoptDecoder?(decoder: unknown): void;
  /** model-viewer's `with-credentials`; three's `Loader` exposes it too. */
  setWithCredentials?(value: boolean): void;
}

/**
 * Optional decoders (D16). three wants instances, not config: a `DRACOLoader`
 * with its decoder path set, a `KTX2Loader` already `detectSupport`-ed against
 * the renderer, and/or `MeshoptDecoder`.
 */
export interface GltfDecoders {
  dracoLoader?: unknown;
  ktx2Loader?: unknown;
  meshoptDecoder?: unknown;
}

/**
 * Push decoders onto a loader. Absent keys are left alone (three keeps whatever
 * it already had), so this is safe to call before every load — which is what
 * makes "assign the decoder property after connect" work without rebuilding the
 * pipeline.
 */
export function applyGltfDecoders(
  loader: MinimalGltfLoader,
  decoders: GltfDecoders | undefined,
): void {
  if (!decoders) return;
  if (decoders.dracoLoader) loader.setDRACOLoader?.(decoders.dracoLoader);
  if (decoders.ktx2Loader) loader.setKTX2Loader?.(decoders.ktx2Loader);
  if (decoders.meshoptDecoder) loader.setMeshoptDecoder?.(decoders.meshoptDecoder);
}

/** Use `load` when progress matters, `loadAsync` otherwise. */
export function loadGltfScene(
  loader: MinimalGltfLoader,
  url: string,
  onProgress?: (progress: AssetLoadProgress) => void,
): Promise<{ scene: unknown; animations?: unknown[] }> {
  if (!onProgress || typeof loader.load !== "function") {
    return loader.loadAsync(url);
  }
  return new Promise((resolve, reject) => {
    loader.load!(
      url,
      (data) => resolve(data),
      (event) => onProgress({ loaded: event.loaded, total: event.total }),
      (error) => reject(error),
    );
  });
}

/**
 * Turn three's terse decoder failures into something the *user* can act on.
 *
 * `GLTFLoader` says "THREE.GLTFLoader: No DRACOLoader instance provided." and
 * that string used to be dropped on the floor: the element only paints the
 * `AssetError` message, which is "Failed to load asset: <id>". A blank canvas
 * with no explanation was the whole complaint behind `decoder-path`.
 *
 * Returns `null` for failures that have nothing to do with decoders, so the
 * caller keeps its message untouched.
 */
export function decoderHint(cause: unknown): string | null {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (/draco/i.test(message)) {
    return "this model uses Draco-compressed geometry, which needs a decoder — set `decoder-path` to a reachable `draco/gltf/` payload (or `decoder-cdn`), or assign `element.dracoLoader`";
  }
  if (/ktx2|basis/i.test(message)) {
    return "this model uses KTX2 textures, which need a transcoder — set `decoder-path` to a reachable `basis/` payload (or `decoder-cdn`), or assign `element.ktx2Loader`";
  }
  if (/meshopt/i.test(message)) {
    return "this model uses Meshopt-compressed geometry, which needs a decoder — set `decoder-path` (or `decoder-cdn`), or assign `element.meshoptDecoder`";
  }
  return null;
}

export interface GltfAssetLoaderOptions {
  /** Base URL or map function resolving assetId → URL. */
  resolveUrl: (assetId: string) => string;
  /** Injected GLTFLoader-like instance (three's GLTFLoader or a stub). */
  gltfLoader: MinimalGltfLoader;
  dracoLoader?: unknown;
  ktx2Loader?: unknown;
  /** Read on every load, so a host can assign decoders after the pipeline exists. */
  decoders?: () => GltfDecoders;
}

/** Supported format matrix (D16). Draco/KTX2 are optional enhancers, not required. */
export const SUPPORTED_ASSET_FORMATS = ["glb", "gltf"] as const;

export function createGltfAssetLoader(options: GltfAssetLoaderOptions) {
  const { resolveUrl, gltfLoader } = options;
  applyGltfDecoders(gltfLoader, {
    dracoLoader: options.dracoLoader,
    ktx2Loader: options.ktx2Loader,
  });

  return async function loadGltfAsset(
    assetId: string,
    context?: AssetLoadContext,
  ): Promise<LoadedAsset> {
    const url = resolveUrl(assetId);
    // Same rule as the resolver loader: URL first, asset id second.
    const ext = assetFormatHint(url, assetId);
    if (ext !== "glb" && ext !== "gltf") {
      throw new AssetError(
        AssetErrorCode.UnsupportedFormat,
        `Unsupported asset format: ${ext ?? "(none)"} (supported: ${SUPPORTED_ASSET_FORMATS.join(", ")})`,
        { detail: { assetId, url, ext } },
      );
    }
    let sceneData: { scene: unknown; animations?: unknown[] };
    try {
      // Re-apply: decoders may have been assigned after this loader was built.
      applyGltfDecoders(gltfLoader, options.decoders?.());
      sceneData = await loadGltfScene(gltfLoader, url, context?.onProgress);
    } catch (cause) {
      const hint = decoderHint(cause);
      throw new AssetError(
        AssetErrorCode.LoadFailed,
        `Failed to load glTF asset: ${assetId}${hint ? ` — ${hint}` : ""}`,
        {
          cause,
          detail: { assetId, url },
        },
      );
    }
    const root = sceneData.scene as { clone?: () => unknown; isObject3D?: boolean };
    const asset: LoadedAsset = {
      scene: root,
      dispose: () => {
        // three GLTFLoader has no dispose; the runtime disposes geometries/materials
        // when the owning object is removed. Here we only guard optional hooks.
        (root as { dispose?: () => void }).dispose?.();
      },
    };
    if (sceneData.animations && sceneData.animations.length > 0) {
      asset.animations = sceneData.animations;
    }
    return asset;
  };
}
