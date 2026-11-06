import type * as THREE from "three";
import type { MaterialDTO, SceneDocument, SceneObjectDTO } from "../../core/document/schema";
import type { AssetCache, LoadedAsset } from "../../assets/asset-cache";
import type { Transform } from "../../runtime/runtime-contract";
import {
  applyMaterialOverride,
  createGroupObject,
  createPlaceholderObject,
  createPrimitiveObject,
  instantiateAsset,
  type MaterialOverrideHandle,
} from "./object-factory";

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
  /** Replace the live scene graph with the document's objects. */
  load(
    doc: SceneDocument,
    onProgress?: (progress: ObjectStoreLoadProgress) => void,
  ): Promise<void>;
  /**
   * Mount one object incrementally; resolves once its asset (if any) is live.
   * Idempotent by id, so a redo after `remove` is safe.
   */
  add(dto: SceneObjectDTO): Promise<void>;
  /** Unmount exactly one object. Cascade ordering is the caller's job. */
  remove(id: string): void;
  /** Re-attach under another parent (`undefined` = scene root). */
  reparent(id: string, parentId: string | undefined): void;
  /** Replace or clear the material override for one object. */
  setMaterial(id: string, material: MaterialDTO | undefined): void;
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
 *
 * Teardown is tracked per id (not on one stack) so an undoable `remove` can
 * release a single object without rebuilding the whole graph.
 */
export function createObjectStore(options: ObjectStoreOptions): ObjectStore {
  const objects = new Map<string, THREE.Object3D>();
  /** Per-object teardown, in mount order (Map order = insertion order). */
  const disposers = new Map<string, () => void>();
  /** Active material overrides — the only way to get the originals back. */
  const overrides = new Map<string, MaterialOverrideHandle>();

  function restoreOverride(id: string): void {
    const handle = overrides.get(id);
    if (!handle) return;
    overrides.delete(id);
    try {
      handle.restore();
    } catch {
      // A failed restore must not block the rest of the teardown.
    }
  }

  /**
   * Register a live object without attaching it. Attachment is a separate pass:
   * document order is not a topological order, so a child may be listed before
   * its parent. `detach` owns graph removal *and* resource release.
   */
  function register(dto: SceneObjectDTO, object: THREE.Object3D, detach: () => void): void {
    objects.set(dto.id, object);
    disposers.set(dto.id, () => {
      restoreOverride(dto.id);
      detach();
    });
  }

  /** Leave the real parent — once parented, `scene.remove()` is a no-op. */
  function removeFromGraph(object: THREE.Object3D): void {
    object.parent?.remove(object);
  }

  function mountLocal(dto: SceneObjectDTO): void {
    if (dto.type === "group") {
      const group = createGroupObject(dto);
      register(dto, group, () => removeFromGraph(group));
      return;
    }
    const built =
      dto.type === "primitive" ? createPrimitiveObject(dto) : createPlaceholderObject(dto);
    register(dto, built.object, () => {
      removeFromGraph(built.object);
      built.dispose();
    });
  }

  async function mountAsset(
    dto: SceneObjectDTO,
    assetId: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const cache = options.assetCache;
    if (!cache) {
      mountLocal(dto);
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
    register(dto, object, () => {
      // release first: removal failure must never leak a refcount (D12)
      cache.release(assetId);
      removeFromGraph(object);
    });
    options.onAssetMounted?.({ objectId: dto.id, object, asset });
  }

  /**
   * Create one object (register + material override) **without** attaching it.
   * `load` uses this pass-then-attach order; `add` attaches right after.
   */
  async function createOne(
    dto: SceneObjectDTO,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    if (dto.type === "mesh" && dto.assetId && options.assetCache) {
      await mountAsset(dto, dto.assetId, onProgress);
    } else {
      mountLocal(dto);
    }

    // Groups carry no surface of their own; their children keep their own DTOs.
    if (dto.material && dto.type !== "group") {
      const object = objects.get(dto.id);
      if (object) overrides.set(dto.id, applyMaterialOverride(object, dto.material));
    }
  }

  /** True when `node` is `candidate` itself or an ancestor of it. */
  function isAncestor(node: THREE.Object3D, candidate: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = candidate;
    while (current) {
      if (current === node) return true;
      current = current.parent;
    }
    return false;
  }

  /** Attach one object under its declared parent, or promote it to a root. */
  function attachOne(dto: SceneObjectDTO): void {
    const object = objects.get(dto.id);
    if (!object) return;
    const parent = dto.parentId === undefined ? undefined : objects.get(dto.parentId);
    if (parent !== undefined && parent !== object && !isAncestor(object, parent)) {
      parent.add(object);
    } else {
      options.scene.add(object);
    }
  }

  /**
   * Turn `parentId` into real three parenting, then mount the roots on the scene.
   *
   * A child whose parent is absent (the parent's asset failed and was skipped)
   * is promoted to a root instead of vanishing, which keeps the partial-success
   * contract of `load`. The cycle guard exists because `createObjectStore` is a
   * public entry point and may be handed a document that skipped validation.
   */
  function attachAll(dtos: readonly SceneObjectDTO[]): void {
    const roots: THREE.Object3D[] = [];

    for (const dto of dtos) {
      const object = objects.get(dto.id);
      if (!object) continue;
      const parent = dto.parentId === undefined ? undefined : objects.get(dto.parentId);
      if (parent !== undefined && parent !== object && !isAncestor(object, parent)) {
        parent.add(object);
      } else {
        roots.push(object);
      }
    }

    if (roots.length > 0) options.scene.add(...roots);
    // Parenting changed the world matrices autoFrame samples right after load.
    options.scene.updateMatrixWorld(true);
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
      // Every object type in the schema is renderable: mesh (asset or
      // placeholder), group (hierarchy only) and primitive (procedural geometry).
      const mountable = doc.objects;
      if (mountable.length === 0) {
        onProgress?.({ totalProgress: 1, reason: "model-load" });
        return;
      }

      const total = mountable.length;
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

      for (const dto of mountable) {
        try {
          await createOne(dto, report);
        } catch (error) {
          // partial success: skip the failed object, keep loading the rest
          options.onAssetError(error, dto);
        }
        done += 1;
        report(0);
      }

      attachAll(mountable);
    },
    async add(dto: SceneObjectDTO): Promise<void> {
      // Idempotent by id: redo re-runs the command on an unchanged graph.
      if (objects.has(dto.id)) return;
      await createOne(dto);
      attachOne(dto);
      options.scene.updateMatrixWorld(true);
    },
    remove(id: string): void {
      const detach = disposers.get(id);
      if (!detach) return;
      disposers.delete(id);
      objects.delete(id);
      try {
        detach();
      } catch {
        // A failed teardown must not abort the surrounding command.
      }
    },
    reparent(id: string, parentId: string | undefined): void {
      const object = objects.get(id);
      if (!object) return;
      const parent = parentId === undefined ? undefined : objects.get(parentId);
      if (parent !== undefined && parent !== object && !isAncestor(object, parent)) {
        parent.add(object);
      } else {
        options.scene.add(object);
      }
      options.scene.updateMatrixWorld(true);
    },
    setMaterial(id: string, material: MaterialDTO | undefined): void {
      restoreOverride(id);
      const object = objects.get(id);
      if (!object || !material) return;
      overrides.set(id, applyMaterialOverride(object, material));
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
      // LIFO: children leave before their parents, so no object is orphaned.
      for (const id of [...disposers.keys()].reverse()) {
        const detach = disposers.get(id);
        if (!detach) continue;
        disposers.delete(id);
        objects.delete(id);
        try {
          detach();
        } catch {
          // object disposal errors must not block reload
        }
      }
      disposers.clear();
      objects.clear();
      overrides.clear();
    },
    dispose(): void {
      store.clear();
    },
  };

  return store;
}
