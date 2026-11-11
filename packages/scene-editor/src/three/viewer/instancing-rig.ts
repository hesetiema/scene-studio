import * as THREE from "three";

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
 * A batch is keyed by *content*, not by instance: two boxes created separately
 * share nothing but their parameters, so the key is derived from
 * `geometry.parameters` + a field-by-field material fingerprint. Anything this
 * module cannot fingerprint exactly (procedural geometry without `parameters`,
 * array- or record-valued material fields, transparency) is simply **not
 * batched** — a missed optimisation, never a wrong pixel.
 *
 * ### Chunks
 *
 * One `InstancedMesh` per content group would be one draw call but *one* cull
 * test: a single bounding sphere around everything, so a 5 000-object scene
 * submits all 5 000 instances no matter where the camera looks. That trades a
 * draw-call problem for a vertex problem.
 *
 * Each group is therefore split into chunks of at most `chunkSize` instances,
 * one `InstancedMesh` each. three's frustum test is per-mesh, so a close-up
 * camera only submits the chunks it can see, while the whole group still costs
 * `ceil(n / chunkSize)` draw calls instead of `n`. The geometry and material
 * are cloned **once per group** and shared by its chunks: chunking costs
 * instance matrices, not another copy of the mesh.
 *
 * Chunk membership is **spatial**, not "the next 256 objects". Cutting the
 * admission order into fixed blocks produces slabs that all span the whole
 * scene — measured: 1 000 boxes, camera in a corner, triangles unchanged at
 * 12 000, i.e. four spheres that all intersect the frustum. So a chunk is a
 * grid cell instead: `layout()` buckets members by world position (grid side
 * chosen so a cell holds about `chunkSize` instances), sorts by cell and fills
 * chunks from that order. Sorting is deferred to the next `sync()` so a 5 000
 * object load pays for one sort, not 5 000.
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

interface Chunk {
  mesh: THREE.InstancedMesh;
  /** Member ids in slot order — the matrix slot of each member. */
  ids: string[];
  /** Member objects, parallel to `ids`. */
  proxies: THREE.Object3D[];
  /** `instanceMatrix` length in instances; grows by doubling. */
  capacity: number;
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

/** First allocation for a chunk; doubling from here keeps growth amortised. */
const MIN_CAPACITY = 16;
/** Matrices are 4×4 floats. */
const STRIDE = 16;

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

/**
 * Material fields that are identity or bookkeeping, never surface appearance.
 * `version` is excluded on purpose: it bumps on every mutation, so including it
 * would put a just-edited material in a batch of its own forever.
 */
const IGNORED_MATERIAL_KEYS: ReadonlySet<string> = new Set([
  "uuid",
  "id",
  "name",
  "type",
  "version",
  "userData",
  "onBeforeCompile",
  "customProgramCacheKey",
  "onBeforeRender",
  "onAfterRender",
]);

/**
 * Content key for a material, or `null` when it cannot be fingerprinted with
 * certainty.
 *
 * Conservative by design: only primitives, `Color`s, textures and vectors are
 * understood. An array or a record (clipping planes, `defines`, a custom
 * uniform bag) can change the program in ways this key cannot see, so the
 * material is refused instead of risked.
 */
export function materialKey(material: THREE.Material): string | null {
  const parts: string[] = [material.type];
  const record = material as unknown as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (IGNORED_MATERIAL_KEYS.has(key)) continue;
    const value = record[key];

    if (value === null || value === undefined) {
      parts.push(`${key}=`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      parts.push(`${key}=${String(value)}`);
      continue;
    }
    if (typeof value === "object") {
      const candidate = value as {
        isColor?: boolean;
        isTexture?: boolean;
        isVector2?: boolean;
        isVector3?: boolean;
        isVector4?: boolean;
        isEuler?: boolean;
        getHexString?: () => string;
        toArray?: () => number[];
        uuid?: string;
      };
      if (candidate.isColor === true && candidate.getHexString) {
        parts.push(`${key}=#${candidate.getHexString()}`);
        continue;
      }
      if (candidate.isTexture === true) {
        parts.push(`${key}=tex:${candidate.uuid ?? ""}`);
        continue;
      }
      if (
        (candidate.isVector2 === true ||
          candidate.isVector3 === true ||
          candidate.isVector4 === true ||
          candidate.isEuler === true) &&
        candidate.toArray
      ) {
        parts.push(`${key}=${candidate.toArray().join(",")}`);
        continue;
      }
      // `defines` is a plain record of shader constants (`{ STANDARD: "" }` on
      // every stock material). Sorted so key order cannot fake a difference.
      if (key === "defines") {
        const entries = Object.entries(value as Record<string, unknown>);
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const rendered = entries.map(([name, entry]) => `${name}:${String(entry)}`).join(",");
        parts.push(`${key}={${rendered}}`);
        continue;
      }
      return null;
    }
    // Functions: `Material` keeps a couple of callbacks we did not list.
    if (key === "onShaderError") continue;
    return null;
  }

  return parts.join("|");
}

/**
 * Content key for a geometry, or `null` when it has no declarative parameters.
 *
 * Every stock three primitive (`BoxGeometry`, `SphereGeometry`, …) records what
 * it was built from, so two objects built from the same document geometry get
 * the same key. A `BufferGeometry` that came out of a glTF has no parameters
 * and therefore is never merged with anything.
 */
export function geometryKey(geometry: THREE.BufferGeometry): string | null {
  const parameters = (geometry as unknown as { parameters?: unknown }).parameters;
  if (!parameters || typeof parameters !== "object") return null;
  try {
    return `${geometry.type}|${JSON.stringify(parameters)}`;
  } catch {
    // Cyclic parameters: give up rather than throw during a load.
    return null;
  }
}

/**
 * Layer the batched proxies are moved to. The main camera renders layer 0 only,
 * so a proxy stops drawing — while staying `visible`, which is what keeps
 * vertex framing (`traverseVisible`), GLB export and host traversal working
 * unchanged. Anything that raycasts has to opt into this layer
 * (`raycaster.layers.enableAll()`, which is what `picker.ts` does).
 */
export const BATCH_PROXY_LAYER = 1;

/** Structural gate: a mesh that draws exactly one thing with one material. */
function affordable(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh !== true) return false;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) return false;
  // A subtree (glTF scene root, articulated model) cannot be one instance.
  if (mesh.children.length > 0) return false;
  if (!mesh.geometry) return false;
  if (Array.isArray(mesh.material)) return false;
  const material = mesh.material as THREE.Material | undefined;
  if (!material) return false;
  // One instanced call has one draw order: per-instance alpha sorting is gone.
  if (material.transparent === true) return false;
  if (material.opacity !== undefined && material.opacity < 1) return false;
  // Only default-layer objects are eligible, so releasing one can restore the
  // default mask instead of guessing what the host had.
  if (mesh.layers.mask !== 1) return false;
  return true;
}

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

  function createChunk(batch: Batch): Chunk {
    const mesh = new THREE.InstancedMesh(
      // Shared with the group's other chunks: one geometry, one material, N
      // draw calls — chunking must not multiply GPU memory.
      batch.geometry,
      batch.material,
      MIN_CAPACITY,
    );
    mesh.name = `batch:${batch.geometry.type}`;
    mesh.count = 0;
    mesh.castShadow = true;
    // Per-mesh cull test: this is what makes chunking worth its draw calls.
    mesh.frustumCulled = true;
    mesh.userData.sceneBatch = true;
    // Drawing only. Picking stays on the proxies (they sit at the same world
    // matrices), so a host raycasting the whole scene finds the document object
    // instead of an anonymous instance.
    mesh.raycast = () => {};
    // Instance matrices are world-space, so the root must never move.
    ensureRoot().add(mesh);
    return { mesh, ids: [], proxies: [], capacity: MIN_CAPACITY };
  }

  /**
   * Grow one chunk's `instanceMatrix` by doubling, preserving written slots.
   *
   * The old attribute's GPU buffer is not explicitly released (three drops it
   * with the attribute's last reference only on context loss), so a load leaves
   * at most twice the live matrix data behind per chunk — 1-2 MB for 5 000
   * instances, and only while doubling. Disposing mid-flight would invalidate
   * the renderer's VAO for a buffer it may still be bound to, which is the worse
   * trade for a bounded, one-off cost.
   */
  function reserve(chunk: Chunk, needed: number): void {
    if (needed <= chunk.capacity) return;
    let capacity = Math.max(chunk.capacity, MIN_CAPACITY);
    while (capacity < needed) capacity = Math.min(capacity * 2, chunkSize);
    const previous = chunk.mesh.instanceMatrix.array as Float32Array;
    const next = new THREE.InstancedBufferAttribute(new Float32Array(capacity * STRIDE), STRIDE);
    next.array.set(previous);
    chunk.mesh.instanceMatrix = next;
    chunk.capacity = capacity;
  }

  /**
   * Membership changed: publish the count and invalidate the cull volume.
   *
   * The sphere is *dropped*, not recomputed: `computeBoundingSphere()` walks
   * every instance, and calling it per admit turns a 5 000-object load into
   * 12.5M sphere unions (measured: +900 ms). three recomputes a null sphere on
   * the next frustum test, i.e. once per frame instead of once per object.
   */
  function publish(chunk: Chunk): void {
    chunk.mesh.count = chunk.ids.length;
    chunk.mesh.instanceMatrix.needsUpdate = true;
    chunk.mesh.boundingSphere = null;
  }

  function disposeChunk(chunk: Chunk): void {
    chunk.mesh.removeFromParent();
    // The mesh owns only its instance-matrix attribute; geometry and material
    // belong to the group.
    chunk.mesh.dispose();
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
   * Two passes: world position + bounds, then a grid bucket sized so a cell
   * holds about `chunkSize` instances. Members sort by grid index, so a chunk is
   * one cell (or the tail of one), and a cell that is too dense spills into the
   * next chunk in the same cell.
   *
   * Returns whether matrices were rewritten; `false` means the caller still has
   * to push them itself.
   */
  function layout(batch: Batch): boolean {
    const count = batch.entries.size;
    // One chunk: there is nothing to split, and the append order already fills it.
    if (count <= chunkSize) return false;

    const items: Array<{ id: string; x: number; y: number; z: number }> = [];
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const position = new THREE.Vector3();
    for (const [id, proxy] of batch.entries) {
      proxy.updateWorldMatrix(true, false);
      position.setFromMatrixPosition(proxy.matrixWorld);
      items.push({ id, x: position.x, y: position.y, z: position.z });
      if (position.x < minX) minX = position.x;
      if (position.y < minY) minY = position.y;
      if (position.z < minZ) minZ = position.z;
      if (position.x > maxX) maxX = position.x;
      if (position.y > maxY) maxY = position.y;
      if (position.z > maxZ) maxZ = position.z;
    }

    // Aim for one cell per chunk. Cell counts are spread per axis in proportion
    // to each axis' extent (grow the axis with the largest current cell until
    // there are enough cells), so a flat scene culls in 2D instead of spending
    // cells on an empty Y — a cube grid put 500 instances in one cell and culled
    // nothing. Near-cubic cells also keep each chunk's bounding sphere small.
    const targetCells = Math.max(1, Math.ceil(count / chunkSize));
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    let nx = 1;
    let ny = 1;
    let nz = 1;
    while (nx * ny * nz < targetCells) {
      const cellX = extentX / nx;
      const cellY = extentY / ny;
      const cellZ = extentZ / nz;
      if (cellX >= cellY && cellX >= cellZ) nx += 1;
      else if (cellZ >= cellY) nz += 1;
      else ny += 1;
    }
    const cellOf = (value: number, min: number, cells: number, extent: number): number =>
      extent > 0
        ? Math.min(cells - 1, Math.max(0, Math.floor(((value - min) / extent) * cells)))
        : 0;

    // Grid index, not a hash: same cell sorts together *and* neighbouring cells
    // sort adjacent, so a chunk boundary rarely straddles two distant cells.
    // `Array.prototype.sort` is stable, so insertion order breaks ties.
    const keyed = items.map((item) => ({
      id: item.id,
      key:
        cellOf(item.z, minZ, nz, extentZ) * nx * ny +
        cellOf(item.y, minY, ny, extentY) * nx +
        cellOf(item.x, minX, nx, extentX),
    }));
    keyed.sort((a, b) => a.key - b.key);

    let cursor = 0;
    for (const item of keyed) {
      const chunkIndex = Math.floor(cursor / chunkSize);
      const index = cursor % chunkSize;
      let chunk = batch.chunks[chunkIndex];
      if (!chunk) {
        chunk = createChunk(batch);
        batch.chunks.push(chunk);
      }
      const proxy = batch.entries.get(item.id)!;
      reserve(chunk, index + 1);
      if (index === chunk.ids.length) {
        chunk.ids.push(item.id);
        chunk.proxies.push(proxy);
      } else {
        chunk.ids[index] = item.id;
        chunk.proxies[index] = proxy;
      }
      (chunk.mesh.instanceMatrix.array as Float32Array).set(
        proxy.matrixWorld.elements,
        index * STRIDE,
      );
      batch.slot.set(item.id, { chunk: chunkIndex, index });
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
    const matrix = chunk.mesh.instanceMatrix.array as Float32Array;
    if (index !== lastIndex) {
      const movedId = chunk.ids[lastIndex]!;
      chunk.ids[index] = movedId;
      chunk.proxies[index] = chunk.proxies[lastIndex]!;
      batch.slot.set(movedId, { chunk: slot.chunk, index });
      // `set` on a subarray of the same buffer behaves like `memmove`.
      matrix.set(matrix.subarray(lastIndex * STRIDE, lastIndex * STRIDE + STRIDE), index * STRIDE);
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

      const geometryKeyValue = geometryKey(object.geometry);
      if (geometryKeyValue === null) return false;
      // Re-checked for the type system; `affordable` already ruled it out.
      const material = object.material;
      if (Array.isArray(material) || !material) return false;
      const materialKeyValue = materialKey(material);
      if (materialKeyValue === null) return false;
      const key = `${geometryKeyValue}||${materialKeyValue}`;

      let batch = batches.get(key);
      if (!batch) {
        batch = {
          key,
          // Clones, not the member's resources: the group must outlive whichever
          // member happened to create it.
          geometry: object.geometry.clone(),
          material: material.clone(),
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
        chunk = createChunk(batch);
        batch.chunks.push(chunk);
        chunkIndex = batch.chunks.length - 1;
      }

      reserve(chunk, chunk.ids.length + 1);
      const index = chunk.ids.length;
      chunk.ids.push(id);
      chunk.proxies.push(object);
      chunk.mesh.instanceMatrix.array.set(object.matrixWorld.elements, index * STRIDE);
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
          const target = chunk.mesh.instanceMatrix.array as Float32Array;
          let moved = false;
          for (let i = 0; i < chunk.proxies.length; i += 1) {
            const world = chunk.proxies[i]!.matrixWorld.elements;
            const offset = i * STRIDE;
            for (let e = 0; e < STRIDE; e += 1) {
              const value = world[e]!;
              if (target[offset + e] !== value) {
                target[offset + e] = value;
                moved = true;
              }
            }
          }
          // Static scenes upload nothing: the compare above is the whole cost.
          if (!moved) continue;
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
