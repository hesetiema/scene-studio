import type * as THREE from "three";
import type { SceneDocument, SceneObjectDTO } from "../../core/document/schema";
import type { AssetCache, LoadedAsset } from "../../assets/asset-cache";
import type { Transform } from "../../runtime/runtime-contract";
import { DisposerStack } from "../../runtime/disposer-stack";
import { createPlaceholderObject, instantiateAsset } from "./object-factory";

export interface AssetMountedInfo {
  objectId: string;
  object: THREE.Object3D;
  asset: LoadedAsset;
}

export interface ObjectStoreOptions {
  scene: THREE.Scene;
  assetCache: AssetCache | null;
  onAssetError: (error: unknown, dto: SceneObjectDTO) => void;
  /** Called after an asset root is mounted — used to register glTF clips. */
  onAssetMounted?: (info: AssetMountedInfo) => void;
}

/** Aggregate progress across the document's meshes (0..1). */
export interface ObjectStoreLoadProgress {
  totalProgress: number;
  reason: string;
}

export interface ObjectStore {
  readonly size: number;
  /** Replace the live scene graph with the document's mesh objects. */
  load(
    doc: SceneDocument,
    onProgress?: (progress: ObjectStoreLoadProgress) => void,
  ): Promise<void>;
  get(id: string): THREE.Object3D | undefined;
  list(): THREE.Object3D[];
  applyTransform(id: string, transform: Transform): boolean;
  clear(): void;
  dispose(): void;
}

/**
 * Owns the id → Object3D registry and per-object disposal (reference:
 * `content` + `clear()`). Asset instances share GPU buffers with the cache, so
 * removal only releases the cache ref — the loader owns the last-release dispose.
 */
export function createObjectStore(options: ObjectStoreOptions): ObjectStore {
  const objects = new Map<string, THREE.Object3D>();
  const disposers = new DisposerStack();

  function addPlaceholder(dto: SceneObjectDTO): void {
    const { object, dispose } = createPlaceholderObject(dto);
    objects.set(dto.id, object);
    options.scene.add(object);
    disposers.add(() => {
      options.scene.remove(object);
      dispose();
    });
  }

  async function addAsset(
    dto: SceneObjectDTO,
    assetId: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const cache = options.assetCache;
    if (!cache) {
      addPlaceholder(dto);
      return;
    }
    const asset = await cache.retain(
      assetId,
      onProgress
        ? {
            onProgress: ({ loaded, total }) => {
              onProgress(total > 0 ? loaded / total : 0);
            },
          }
        : undefined,
    );
    const object = instantiateAsset(asset.scene, dto);
    objects.set(dto.id, object);
    options.scene.add(object);
    disposers.add(() => {
      // release first: removal failure must never leak a refcount (D12)
      cache.release(assetId);
      options.scene.remove(object);
    });
    options.onAssetMounted?.({ objectId: dto.id, object, asset });
  }

  const store: ObjectStore = {
    get size(): number {
      return objects.size;
    },
    async load(
      doc: SceneDocument,
      onProgress?: (progress: ObjectStoreLoadProgress) => void,
    ): Promise<void> {
      store.clear();
      const meshes = doc.objects.filter((dto) => dto.type === "mesh");
      if (meshes.length === 0) {
        onProgress?.({ totalProgress: 1, reason: "model-load" });
        return;
      }

      const total = meshes.length;
      let done = 0;
      let lastReported = -1;
      // Explicit zero: hosts can switch a progress bar into "loading" state.
      onProgress?.({ totalProgress: 0, reason: "model-load" });
      // Byte progress is per asset; normalize it into the document-wide slice
      // so a multi-object document reports one monotonic 0..1 curve.
      const report = (fraction: number): void => {
        const totalProgress = Math.min(1, (done + Math.min(fraction, 1)) / total);
        if (totalProgress < 1 && totalProgress - lastReported < 0.01) return;
        lastReported = totalProgress;
        onProgress?.({ totalProgress, reason: "model-load" });
      };

      for (const dto of meshes) {
        if (dto.assetId && options.assetCache) {
          try {
            await addAsset(dto, dto.assetId, report);
          } catch (error) {
            // partial success: skip the failed object, keep loading the rest
            options.onAssetError(error, dto);
          }
        } else {
          addPlaceholder(dto);
        }
        done += 1;
        report(0);
      }
    },
    get(id: string): THREE.Object3D | undefined {
      return objects.get(id);
    },
    list(): THREE.Object3D[] {
      return [...objects.values()];
    },
    applyTransform(id: string, transform: Transform): boolean {
      const object = objects.get(id);
      if (!object) return false;
      const [px, py, pz] = transform.position;
      const [rx, ry, rz] = transform.rotation;
      const [sx, sy, sz] = transform.scale;
      object.position.set(px, py, pz);
      object.rotation.set(rx, ry, rz);
      object.scale.set(sx, sy, sz);
      return true;
    },
    clear(): void {
      try {
        disposers.flush();
      } catch {
        // object disposal errors must not block reload
      }
      objects.clear();
    },
    dispose(): void {
      store.clear();
    },
  };

  return store;
}
