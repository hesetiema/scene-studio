import * as THREE from "three";
import { BATCH_PROXY_LAYER, affordable, contentKey } from "./instancing/fingerprint";
import {
  createChunk,
  disposeChunk,
  moveSlot,
  publish,
  pushMatrices,
  reserve,
  writeSlot,
  type Chunk,
} from "./instancing/chunks";
import { planSpatialOrder, type LayoutItem } from "./instancing/layout";

/**
 * Draw-call batching for repeated primitive meshes.
 *
 * The *object model* stays per-object: every document object keeps its own
 * `Object3D`, its own transform, its own material instance and its own pick
 * entry. Batching only changes **who draws it**. Meshes that are identical in
 * everything but their world matrix — same geometry parameters, same material
 * fields — are absorbed into `InstancedMesh`es and the original mesh is moved
 * to a layer the camera does not draw:
 *
 * - picking still works: proxies keep their own geometry and matrix, so a hit
 *   on one is already a hit on the right object — the raycast just has to look
 *   at the proxy layer (`BATCH_PROXY_LAYER`);
 * - `bounds()` / framing still work, because the proxy is still in the graph,
 *   still `visible`, and still carries the geometry;
 * - export still works: `GLTFExporter` reads the proxy, not the batch.
 *
 * Merging (`BufferGeometryUtils.mergeGeometries`) would be faster still, but it
 * destroys object identity — `getObjectById`, per-object materials, undoable
 * transforms — which is the entire point of the editor. Hiding a mesh keeps all
 * of that and still collapses N draw calls into one.
 *
 * Three concerns live beside this file, each with its own doc block:
 *
 * - `instancing/fingerprint` — what counts as "the same content" (`materialKey`,
 *   `geometryKey`) and what is allowed to batch at all (`affordable`);
 * - `instancing/chunks` — one `InstancedMesh`, its matrix slots, growth and
 *   disposal;
 * - `instancing/layout` — the pure spatial ordering that decides which member
 *   sits in which chunk.
 *
 * This file owns membership: `id → batch`, the append/swap-remove bookkeeping,
 * and the deferred re-layout.
 */
export interface InstancingStats {
  /** Content groups (one geometry + material fingerprint each). */
  batches: number;
  /** Live `InstancedMesh`es — one draw call each when in frustum. */
  chunks: number;
  instances: number;
}

export interface InstancingRig {
  /** Absorb `object` into a shared `InstancedMesh`; `false` = not eligible. */
  admit(id: string, object: THREE.Object3D): boolean;
  /** Give the object its own draw call back (selection, material override). */
  exclude(id: string): void;
  /** The object is leaving the graph. */
  detach(id: string): void;
  /**
   * `object`'s subtree moved and the renderer has not refreshed it yet.
   * Takes the object, not the id: the moved node is often a *group* whose
   * batched children are the ones that need new matrices.
   */
  markDirty(object: THREE.Object3D): void;
  /** Push instance matrices; no-op when nothing moved. */
  sync(): void;
  /** Scene child owning the `InstancedMesh`es; `null` while nothing is batched. */
  root(): THREE.Object3D | null;
  stats(): InstancingStats;
  /** Drop every batch (content cleared). */
  clear(): void;
  dispose(): void;
}

/** Where one member sits: which chunk, which matrix slot inside it. */
interface Slot {
  chunk: number;
  index: number;
}

interface Batch {
  key: string;
  /** Clone owned by the group and shared by every chunk. */
  geometry: THREE.BufferGeometry;
  /** Clone owned by the group and shared by every chunk. */
  material: THREE.Material;
  /**
   * Members in admission order (id → proxy). The authoritative membership list:
   * chunks are a *layout* of it and can be rebuilt at any time from this.
   */
  entries: Map<string, THREE.Object3D>;
  chunks: Chunk[];
  /** id → position, kept in step with the append and the swap-removes. */
  slot: Map<string, Slot>;
  /** Membership changed: the next `sync()` re-buckets the group spatially. */
  needsLayout: boolean;
}

/**
 * Default instances per `InstancedMesh`.
 *
 * 256 keeps the cull volume tight enough to matter — a 5 000-object scene is 20
 * chunks and a narrow close-up submits about a third of it instead of all of it
 * (measured 18 432 → vs 60 000 triangles; the fraction keeps falling as scenes
 * grow, because a close-up only ever touches a handful of chunks) — while
 * leaving the worst-case draw-call count two orders of magnitude below
 * unbatched. Halving it to 128 measured 16 896 triangles for twice the draw
 * calls, i.e. past the knee.
 */
const DEFAULT_CHUNK_SIZE = 256;

export interface InstancingRigOptions {
  /** Scene the batch root is attached to. */
  scene: THREE.Scene;
  /**
   * Instances per `InstancedMesh` (default 256). Smaller chunks cull harder and
   * cost more draw calls; `1` degenerates to one mesh per chunk of one.
   */
  chunkSize?: number;
}

export function createInstancingRig(options: InstancingRigOptions): InstancingRig {
  const { scene } = options;
  const chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const batches = new Map<string, Batch>();
  /** id → batch, for `exclude` / `detach` lookups. */
  const membership = new Map<string, Batch>();
  /** Subtree roots whose world matrices were invalidated outside `sync()`. */
  const dirty = new Set<THREE.Object3D>();
  let root: THREE.Group | null = null;

  function ensureRoot(): THREE.Group {
    if (root === null) {
      root = new THREE.Group();
      root.name = "scene-batches";
      root.userData.sceneBatchRoot = true;
      scene.add(root);
    }
    return root;
  }

  function releaseRootIfEmpty(): void {
    if (batches.size > 0 || root === null) return;
    scene.remove(root);
    root = null;
  }

  function makeChunk(batch: Batch): Chunk {
    return createChunk(ensureRoot(), {
      geometry: batch.geometry,
      material: batch.material,
      label: batch.geometry.type,
    });
  }

  function disposeBatch(batch: Batch): void {
    for (const chunk of batch.chunks) {
      disposeChunk(chunk);
      // Leaving the batch means drawing yourself again.
      for (const proxy of chunk.proxies) proxy.layers.set(0);
      for (const id of chunk.ids) membership.delete(id);
    }
    batch.chunks.length = 0;
    batch.entries.clear();
    batch.slot.clear();
    batch.geometry.dispose();
    batch.material.dispose();
    batches.delete(batch.key);
  }

  /**
   * Re-bucket one group spatially and rewrite every instance slot.
   *
   * Deferred to `sync()` on purpose: a 5 000-object load admits 5 000 times, and
   * sorting inside `admit` would be O(n²·log n). Until the first layout the
   * append order is used, which is already *correct* — just not cull-friendly.
   *
   * Returns whether matrices were rewritten; `false` means the caller still has
   * to push them itself.
   */
  function layout(batch: Batch): boolean {
    const items: LayoutItem[] = [];
    const position = new THREE.Vector3();
    for (const [id, proxy] of batch.entries) {
      // Admitting and re-laying out both happen outside the render loop, so the
      // world matrix has to be brought current here.
      proxy.updateWorldMatrix(true, false);
      position.setFromMatrixPosition(proxy.matrixWorld);
      items.push({ id, x: position.x, y: position.y, z: position.z });
    }

    const order = planSpatialOrder(items, chunkSize);
    if (order === null) return false;

    let cursor = 0;
    for (const id of order) {
      const chunkIndex = Math.floor(cursor / chunkSize);
      const index = cursor % chunkSize;
      let chunk = batch.chunks[chunkIndex];
      if (!chunk) {
        chunk = makeChunk(batch);
        batch.chunks.push(chunk);
      }
      const proxy = batch.entries.get(id)!;
      reserve(chunk, index + 1, chunkSize);
      if (index === chunk.ids.length) {
        chunk.ids.push(id);
        chunk.proxies.push(proxy);
      } else {
        chunk.ids[index] = id;
        chunk.proxies[index] = proxy;
      }
      writeSlot(chunk, index, proxy.matrixWorld);
      batch.slot.set(id, { chunk: chunkIndex, index });
      cursor += 1;
    }

    // The layout may need fewer chunks than the append order did.
    for (let i = batch.chunks.length - 1; i >= Math.ceil(cursor / chunkSize); i -= 1) {
      disposeChunk(batch.chunks.pop()!);
    }
    let remaining = cursor;
    for (const chunk of batch.chunks) {
      const length = Math.min(chunkSize, remaining);
      remaining -= length;
      chunk.ids.length = length;
      chunk.proxies.length = length;
      publish(chunk);
    }
    return true;
  }

  /** Drop one chunk (its last member left) and keep the survivors' slots valid. */
  function removeChunk(batch: Batch, index: number): void {
    const chunk = batch.chunks[index]!;
    disposeChunk(chunk);
    // Swap-remove the chunk itself: only the chunk that slides into the hole
    // needs its members re-indexed, so this stays O(chunkSize) not O(n).
    const last = batch.chunks.pop()!;
    if (last !== chunk) {
      batch.chunks[index] = last;
      for (const memberId of last.ids) {
        const entry = batch.slot.get(memberId);
        if (entry) entry.chunk = index;
      }
    }
    if (batch.chunks.length === 0) {
      disposeBatch(batch);
      releaseRootIfEmpty();
    }
  }

  /** Detach one member; shared by `exclude` and `detach`. */
  function releaseMember(id: string): void {
    const batch = membership.get(id);
    if (!batch) return;
    const slot = batch.slot.get(id);
    if (!slot) return;
    const chunk = batch.chunks[slot.chunk];
    if (!chunk) return;

    const index = slot.index;
    const lastIndex = chunk.ids.length - 1;
    // Capture before the swap: the released proxy is the one being popped, not
    // the one that moves into its slot.
    const proxy = chunk.proxies[index];
    if (index !== lastIndex) {
      const movedId = chunk.ids[lastIndex]!;
      chunk.ids[index] = movedId;
      chunk.proxies[index] = chunk.proxies[lastIndex]!;
      batch.slot.set(movedId, { chunk: slot.chunk, index });
      moveSlot(chunk, lastIndex, index);
    }
    chunk.ids.pop();
    chunk.proxies.pop();
    batch.slot.delete(id);
    batch.entries.delete(id);
    // The freed slot is a gap in the spatial order: re-bucket on the next frame.
    batch.needsLayout = batch.entries.size > chunkSize;
    membership.delete(id);
    proxy?.layers.set(0);

    if (chunk.ids.length === 0) {
      removeChunk(batch, slot.chunk);
      return;
    }
    publish(chunk);
  }

  /** Drop every batch: objects own their resources, batches own their clones. */
  function clearAll(): void {
    for (const batch of [...batches.values()]) disposeBatch(batch);
    batches.clear();
    membership.clear();
    dirty.clear();
    releaseRootIfEmpty();
  }

  return {
    admit(id: string, object: THREE.Object3D): boolean {
      if (membership.has(id)) return true;
      if (!affordable(object)) return false;

      const key = contentKey(object);
      if (key === null) return false;

      let batch = batches.get(key);
      if (!batch) {
        batch = {
          key,
          // Clones, not the member's resources: the group must outlive whichever
          // member happened to create it.
          geometry: object.geometry.clone(),
          material: (object.material as THREE.Material).clone(),
          entries: new Map(),
          chunks: [],
          slot: new Map(),
          needsLayout: false,
        };
        batches.set(key, batch);
      }

      // `admit` is called right after attachment; make the world matrix current
      // without waiting for the renderer (and without one in tests).
      object.updateWorldMatrix(true, false);

      // Fill the newest chunk first: a load appends in document order, so only
      // the tail chunk is ever partly full.
      let chunk = batch.chunks.at(-1);
      let chunkIndex = batch.chunks.length - 1;
      if (!chunk || chunk.ids.length >= chunkSize) {
        chunk = makeChunk(batch);
        batch.chunks.push(chunk);
        chunkIndex = batch.chunks.length - 1;
      }

      reserve(chunk, chunk.ids.length + 1, chunkSize);
      const index = chunk.ids.length;
      chunk.ids.push(id);
      chunk.proxies.push(object);
      writeSlot(chunk, index, object.matrixWorld);
      batch.slot.set(id, { chunk: chunkIndex, index });
      batch.entries.set(id, object);
      // Only worth a spatial pass once the group needs more than one chunk.
      if (batch.entries.size > chunkSize) batch.needsLayout = true;
      // Off the rendered layer, not out of the graph: raycasting, bounds,
      // framing and export all still see it.
      object.layers.set(BATCH_PROXY_LAYER);
      membership.set(id, batch);
      publish(chunk);
      return true;
    },

    exclude(id: string): void {
      releaseMember(id);
    },

    detach(id: string): void {
      releaseMember(id);
    },

    markDirty(object: THREE.Object3D): void {
      dirty.add(object);
    },

    sync(): void {
      if (dirty.size > 0) {
        for (const object of dirty) {
          // `true, true`: a moved group carries its batched children along, and
          // `true` also refreshes any parent whose matrix is stale.
          object.updateWorldMatrix(true, true);
        }
        dirty.clear();
      }

      for (const batch of batches.values()) {
        if (batch.needsLayout) {
          batch.needsLayout = false;
          // Membership moved: rebuild the buckets (and every instance matrix
          // with them), so the in-place compare below has nothing left to do.
          // A group that fits in one chunk is already correctly laid out — the
          // compare still has to run for it.
          if (layout(batch)) continue;
        }
        for (const chunk of batch.chunks) {
          // Static scenes upload nothing: the compare is the whole cost.
          if (!pushMatrices(chunk)) continue;
          chunk.mesh.instanceMatrix.needsUpdate = true;
          // Same lazy trade as `publish`: one recompute per frame, only on motion.
          chunk.mesh.boundingSphere = null;
        }
      }
    },

    root(): THREE.Object3D | null {
      return root;
    },

    stats(): InstancingStats {
      let chunks = 0;
      let instances = 0;
      for (const batch of batches.values()) {
        chunks += batch.chunks.length;
        for (const chunk of batch.chunks) instances += chunk.ids.length;
      }
      return { batches: batches.size, chunks, instances };
    },

    clear(): void {
      clearAll();
    },

    dispose(): void {
      clearAll();
    },
  };
}
