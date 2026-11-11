import * as THREE from "three";
import type { MaterialDTO, SceneDocument, SceneObjectDTO } from "../../core/document/schema";
import type { AssetCache, LoadedAsset } from "../../assets/asset-cache";
import { AssetError, AssetErrorCode } from "../../assets/asset-error";
import type { Transform } from "../../runtime/runtime-contract";
import { variantTableFor } from "../../assets/material-variants";
import {
  applyMaterialOverride,
  createGroupObject,
  createPlaceholderObject,
  createPrimitiveObject,
  instantiateAsset,
  type MaterialOverrideHandle,
} from "./object-factory";
import {
  createSharedResourcePool,
  type SharedResourcePool,
  type SharedResourceStats,
} from "./shared-resources";
import { mergeAssetMeshes, type AssetMergeHandle } from "./asset-merge";

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
  /**
   * Draw-call batcher (`createInstancingRig`). The store owns *eligibility*:
   * an object with a material override, an asset subtree or a current selection
   * keeps its own draw call, everything else may be absorbed into a shared
   * `InstancedMesh`. `null` disables batching entirely.
   */
  batcher?: ObjectBatcher | null;
  /**
   * Shared placeholder resources (geometry / base material dedupe). Omit to let
   * the store own one; pass the runtime's pool so teardown releases everything
   * in one place.
   */
  resources?: SharedResourcePool;
}

/**
 * The slice of `createInstancingRig` the store talks to. Structural so a host
 * (or a test) can substitute its own batching strategy.
 */
export interface ObjectBatcher {
  /** Absorb a mesh; `false` = not eligible (no harm done). */
  admit(id: string, object: THREE.Object3D): boolean;
  /** Hand one object its own draw call back; no-op when not batched. */
  exclude(id: string): void;
  /** The object is leaving the graph. */
  detach(id: string): void;
  /** World matrices changed and the renderer has not refreshed them yet. */
  markDirty(object: THREE.Object3D): void;
  /** Drop every batch (document replaced). */
  clear(): void;
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
  /**
   * Switch every mounted asset to a `KHR_materials_variants` variant; `null`
   * restores each asset's own materials. Remembered across loads, so a variant
   * set before `src` finishes loading still applies.
   *
   * Objects carrying a document material override are skipped: an explicit
   * material is a stronger statement than a viewer-level variant pick.
   *
   * Returns whether any mounted asset actually declares that variant.
   */
  setVariant(name: string | null): boolean;
  /** Variant names declared by the mounted assets, in document order. */
  variants(): string[];
  /** Currently applied variant (`null` = asset default). */
  readonly variantName: string | null;
  /**
   * Swap the batching strategy (or turn batching off with `null`).
   *
   * Every mounted object is re-evaluated, so this is the live half of
   * `instancing`: the viewport flips between "one draw call per repeat" and
   * "one draw call per object" without reloading the document. `null` and a
   * fresh rig both work — the outgoing rig has already been cleared or is
   * cleared here, and each object gets its default layer back before being
   * re-admitted.
   */
  setBatcher(batcher: ObjectBatcher | null): void;
  get(id: string): THREE.Object3D | undefined;
  list(): THREE.Object3D[];
  /**
   * Record the current selection. Selected objects are never batched: the
   * gizmo, the highlight plugin and the material panel all address them as
   * individual meshes, and a selected object is the one that moves next.
   */
  setSelected(ids: readonly string[]): void;
  /** World-space bounds of everything mounted; empty when nothing is loaded. */
  bounds(): THREE.Box3;
  /**
   * Live shared-resource counters: distinct geometry buffers / materials and
   * how many objects reference them. A 5 000-box document reads
   * `{ geometries: 1, materials: 1 }` when everything is identical.
   */
  resources(): SharedResourceStats;
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
  /** Loaded assets per object id — the variant tables live on them. */
  const assets = new Map<string, LoadedAsset>();
  /** Current selection; mirrors the runtime's `selectedIds`. */
  let selected: ReadonlySet<string> = new Set();
  let variantName: string | null = null;
  /**
   * Batching strategy. Mutable: `setBatcher` swaps it, and every eligibility
   * decision below reads this binding rather than the constructor option.
   */
  let batcher: ObjectBatcher | null = options.batcher ?? null;
  /** Geometry/material dedupe for placeholders and primitives. */
  const resources: SharedResourcePool = options.resources ?? createSharedResourcePool();
  /** Only a pool this store created is disposed here. */
  const ownsResources = options.resources === undefined;

  /**
   * Decide, again, whether one object should be batched.
   *
   * Every path that can change the answer calls this: attaching, clearing a
   * material override, selecting. Cheap (one map lookup per reason) and
   * idempotent, which is what keeps the batcher authoritative without the
   * runtime having to know the rules.
   */
  function refreshBatching(id: string): void {
    if (!batcher) return;
    const object = objects.get(id);
    if (!object) return;
    if (selected.has(id) || overrides.has(id) || assets.has(id)) {
      // Any one reason is enough to need a private draw call.
      batcher.exclude(id);
      return;
    }
    batcher.admit(id, object);
  }

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
   * Point one instance's material slots at `variantName` (or back at the asset's
   * own material when it is `null`).
   *
   * Meshes are matched through `userData`, which `Object3D.clone` copies over
   * JSON — the table itself cannot live in `userData` for the same reason, so it
   * stays on the cached asset and is looked up by that string.
   */
  function applyVariantToObject(
    id: string,
    object: THREE.Object3D,
    set: LoadedAsset["variants"],
  ): void {
    if (!set) return;
    // A document material override outranks a viewer-level variant pick.
    if (overrides.has(id)) return;
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const table = variantTableFor(mesh, set);
      if (!table) return;
      const chosen = variantName === null ? undefined : table.byName.get(variantName);
      mesh.material = chosen ?? table.base;
    });
  }

  /** Re-apply the current variant to every mounted instance. */
  function applyVariant(): void {
    for (const [id, object] of objects) {
      applyVariantToObject(id, object, assets.get(id)?.variants);
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

  /** Flag every mesh in the subtree as a shadow caster (idempotent). */
  function markShadowCaster(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh === true) mesh.castShadow = true;
    });
  }

  function mountLocal(dto: SceneObjectDTO): void {
    if (dto.type === "group") {
      const group = createGroupObject(dto);
      register(dto, group, () => removeFromGraph(group));
      return;
    }
    const built =
      dto.type === "primitive"
        ? createPrimitiveObject(dto, resources)
        : createPlaceholderObject(dto, resources);
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
      // Unreachable through `createOne`; kept for direct callers of the store.
      throw new AssetError(
        AssetErrorCode.NotFound,
        `Cannot mount asset "${assetId}": no asset cache on this store`,
        { detail: { objectId: dto.id, assetId } },
      );
    }
    const asset = await cache.retain(
      assetId,
      onProgress
        ? {
            onProgress: ({ loaded, total }) => {
              // Unknown length (chunked / no Content-Length): a bounded asymptote
              // still moves the bar instead of pinning it at 0 until the end.
              onProgress(total > 0 ? loaded / total : loaded / (loaded + 1_000_000));
            },
          }
        : undefined,
    );
    const object = instantiateAsset(asset.scene, dto);
    // Static merge inside the instance: a glTF modelled as 200 separate meshes
    // that share a material becomes one draw call per material. Skipped when the
    // asset has clips (they target nodes that would no longer exist as meshes)
    // or variants (a variant switch rewrites `mesh.material` per node).
    const merge: AssetMergeHandle | null =
      (asset.animations?.length ?? 0) === 0 && asset.variants === undefined
        ? mergeAssetMeshes(object)
        : null;
    assets.set(dto.id, asset);
    // A variant chosen before the asset finished loading still wins.
    applyVariantToObject(dto.id, object, asset.variants);
    register(dto, object, () => {
      // release first: removal failure must never leak a refcount (D12)
      assets.delete(dto.id);
      cache.release(assetId);
      // Merged buffers are ours; the asset cache owns everything else.
      merge?.restore();
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
    if (dto.type === "mesh" && dto.assetId) {
      // An object that names an asset but has no cache to load it through used
      // to fall back to the 1x1x1 placeholder *silently*: progress reached 1 and
      // `load` fired over an empty viewport. Fail loudly instead — the object
      // store reports per-object errors, so the rest of the document still loads.
      if (!options.assetCache) {
        throw new AssetError(
          AssetErrorCode.NotFound,
          `Cannot mount asset "${dto.assetId}": this runtime has no asset cache`,
          { detail: { objectId: dto.id, assetId: dto.assetId } },
        );
      }
      await mountAsset(dto, dto.assetId, onProgress);
    } else {
      mountLocal(dto);
    }

    const object = objects.get(dto.id);
    if (!object) return;

    // Casters are opt-in per mesh; the contact-shadow plane only sees these.
    markShadowCaster(object);

    // Groups carry no surface of their own; their children keep their own DTOs.
    if (dto.material && dto.type !== "group") {
      overrides.set(dto.id, applyMaterialOverride(object, dto.material));
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
    options.scene.updateMatrixWorld(true);
    refreshBatching(dto.id);
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
    // Batching last: an object is only assigned once its parent is real, so the
    // instance matrix written here is already the final world transform.
    for (const dto of dtos) refreshBatching(dto.id);
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
      batcher?.detach(id);
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
      // Batched children follow their parent; the batcher recomputes the whole
      // subtree rather than one world matrix.
      batcher?.markDirty(object);
    },
    setSelected(ids: readonly string[]): void {
      const next = new Set(ids);
      const previous = selected;
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) return;
      selected = next;
      for (const id of next) {
        if (!previous.has(id)) refreshBatching(id);
      }
      for (const id of previous) {
        if (!next.has(id)) refreshBatching(id);
      }
    },
    setMaterial(id: string, material: MaterialDTO | undefined): void {
      restoreOverride(id);
      const object = objects.get(id);
      if (!object) return;
      if (material) {
        overrides.set(id, applyMaterialOverride(object, material));
        // A per-object material cannot be shared with 5 000 instances.
        refreshBatching(id);
        return;
      }
      // Override cleared → the variant (or the asset default) is in charge again.
      applyVariantToObject(id, object, assets.get(id)?.variants);
      refreshBatching(id);
    },
    setVariant(name: string | null): boolean {
      variantName = name;
      applyVariant();
      return name === null || store.variants().includes(name);
    },
    variants(): string[] {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const asset of assets.values()) {
        for (const name of asset.variants?.names ?? []) {
          if (seen.has(name)) continue;
          seen.add(name);
          names.push(name);
        }
      }
      return names;
    },
    get variantName(): string | null {
      return variantName;
    },
    get(id: string): THREE.Object3D | undefined {
      return objects.get(id);
    },
    list(): THREE.Object3D[] {
      return [...objects.values()];
    },
    bounds(): THREE.Box3 {
      const box = new THREE.Box3();
      for (const object of objects.values()) {
        // Roots only: `expandByObject` already walks descendants.
        if (object.parent !== options.scene) continue;
        box.expandByObject(object);
      }
      return box;
    },
    resources(): SharedResourceStats {
      return resources.stats();
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
      // The renderer has not run yet: the batcher must refresh this subtree
      // itself, or a single-frame scene stays on stale instance matrices.
      batcher?.markDirty(object);
      return true;
    },
    clear(): void {
      // Batches go first: they hold their own resource clones, and a stale
      // batch would keep drawing after its members are gone.
      batcher?.clear();
      selected = new Set();
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
      assets.clear();
    },
    dispose(): void {
      store.clear();
      // A pool supplied by the caller outlives this store; the one created here
      // does not, and disposing it is what keeps teardown at zero.
      if (ownsResources) resources.dispose();
    },
    setBatcher(next: ObjectBatcher | null): void {
      if (next === batcher) return;
      // Release the outgoing strategy first: `exclude` is what restores a
      // member's default layer, so admitting it into the new rig afterwards
      // starts from a clean mask instead of a stale layer bit.
      if (batcher) for (const id of objects.keys()) batcher.exclude(id);
      batcher = next;
      for (const id of objects.keys()) refreshBatching(id);
    },
  };

  return store;
}
