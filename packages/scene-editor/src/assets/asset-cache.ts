import { AssetError, AssetErrorCode } from "./asset-error";

export interface LoadedAsset {
  /** Opaque runtime-specific handle (e.g. THREE.Group). */
  scene: unknown;
  /** Optional dispose hook owned by the loader. */
  dispose?: () => void;
  /** Optional metadata about the asset (e.g. bounding box, polycount). */
  metadata?: unknown;
}

export type AssetLoader = (assetId: string) => Promise<LoadedAsset>;

interface CacheEntry {
  asset: LoadedAsset | undefined;
  refCount: number;
  pending?: Promise<LoadedAsset> | undefined;
}

/**
 * assetId-level shared cache with refcounting (D11/D12).
 * - retain/release owns the lifecycle; dispose is called when refCount hits 0
 * - parallel retains of the same id collapse to one load
 * - eviction at refCount 0 → next retain reloads
 */
export class AssetCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #loader: AssetLoader;

  constructor(loader: AssetLoader) {
    this.#loader = loader;
  }

  has(assetId: string): boolean {
    return this.#entries.has(assetId);
  }

  /** Current refcount (0 = not held). */
  refCount(assetId: string): number {
    return this.#entries.get(assetId)?.refCount ?? 0;
  }

  async get(assetId: string): Promise<LoadedAsset> {
    const entry = this.#entries.get(assetId);
    if (entry?.asset) return entry.asset;
    if (entry?.pending) return entry.pending;
    throw new AssetError(AssetErrorCode.NotFound, `Asset not loaded: ${assetId}`, {
      detail: { assetId },
    });
  }

  async retain(assetId: string): Promise<LoadedAsset> {
    let entry = this.#entries.get(assetId);
    if (entry?.asset) {
      entry.refCount += 1;
      return entry.asset;
    }
    if (entry?.pending) {
      const asset = await entry.pending;
      entry.asset = asset;
      entry.pending = undefined;
      entry.refCount += 1;
      return asset;
    }
    entry = { asset: undefined, refCount: 0 };
    this.#entries.set(assetId, entry);
    const pending = this.#loader(assetId).catch((cause) => {
      this.#entries.delete(assetId);
      throw new AssetError(AssetErrorCode.LoadFailed, `Failed to load asset: ${assetId}`, {
        cause,
        detail: { assetId },
      });
    });
    entry.pending = pending;
    const asset = await pending;
    entry.asset = asset;
    entry.pending = undefined;
    entry.refCount = 1;
    return asset;
  }

  release(assetId: string): void {
    const entry = this.#entries.get(assetId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.#entries.delete(assetId);
      try {
        entry.asset?.dispose?.();
      } catch {
        // dispose is best-effort (D12: loader owns GPU cleanup on last release)
      }
    }
  }

  clear(): void {
    for (const [id, entry] of this.#entries) {
      try {
        entry.asset?.dispose?.();
      } catch {
        // ignore
      }
      this.#entries.delete(id);
    }
  }
}
