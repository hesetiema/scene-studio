import * as THREE from "three";

/**
 * Chunk mechanics: one `InstancedMesh` and the bookkeeping that keeps its
 * matrix slots in step with a member list.
 *
 * Everything here is per-`InstancedMesh`; which members belong to which chunk,
 * and why chunks are split spatially, is the rig's business (`instancing-rig`).
 *
 * Chunking exists for culling: three's frustum test is per-mesh, so one huge
 * `InstancedMesh` would be one cull test around everything — a 5 000-object
 * scene would submit all 5 000 instances no matter where the camera looks.
 */

/** First allocation for a chunk; doubling from here keeps growth amortised. */
export const MIN_CAPACITY = 16;
/** Matrices are 4×4 floats. */
export const STRIDE = 16;

export interface Chunk {
  mesh: THREE.InstancedMesh;
  /** Member ids in slot order — the matrix slot of each member. */
  ids: string[];
  /** Member objects, parallel to `ids`. */
  proxies: THREE.Object3D[];
  /** `instanceMatrix` length in instances; grows by doubling. */
  capacity: number;
}

/** The group-owned resources every chunk of a batch shares. */
export interface ChunkContent {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Used for the mesh name only. */
  label: string;
}

export function createChunk(parent: THREE.Object3D, content: ChunkContent): Chunk {
  const mesh = new THREE.InstancedMesh(
    // Shared with the group's other chunks: one geometry, one material, N
    // draw calls — chunking must not multiply GPU memory.
    content.geometry,
    content.material,
    MIN_CAPACITY,
  );
  mesh.name = `batch:${content.label}`;
  mesh.count = 0;
  mesh.castShadow = true;
  // Per-mesh cull test: this is what makes chunking worth its draw calls.
  mesh.frustumCulled = true;
  mesh.userData.sceneBatch = true;
  // Drawing only. Picking stays on the proxies (they sit at the same world
  // matrices), so a host raycasting the whole scene finds the document object
  // instead of an anonymous instance.
  mesh.raycast = () => {};
  // Instance matrices are world-space, so the parent must never move.
  parent.add(mesh);
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
export function reserve(chunk: Chunk, needed: number, chunkSize: number): void {
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
export function publish(chunk: Chunk): void {
  chunk.mesh.count = chunk.ids.length;
  chunk.mesh.instanceMatrix.needsUpdate = true;
  chunk.mesh.boundingSphere = null;
}

/** Write one member's world matrix into its slot. */
export function writeSlot(chunk: Chunk, index: number, matrix: THREE.Matrix4): void {
  (chunk.mesh.instanceMatrix.array as Float32Array).set(matrix.elements, index * STRIDE);
}

/**
 * Copy every live proxy's world matrix into its slot, in place.
 *
 * Returns whether anything actually changed — a static scene uploads nothing,
 * so the compare itself is the whole cost of a frame's `sync()`.
 */
export function pushMatrices(chunk: Chunk): boolean {
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
  return moved;
}

export function disposeChunk(chunk: Chunk): void {
  chunk.mesh.removeFromParent();
  // The mesh owns only its instance-matrix attribute; geometry and material
  // belong to the group.
  chunk.mesh.dispose();
}

/** Move one slot's matrix onto another; `set` on a subarray behaves like memmove. */
export function moveSlot(chunk: Chunk, from: number, to: number): void {
  const matrix = chunk.mesh.instanceMatrix.array as Float32Array;
  matrix.set(matrix.subarray(from * STRIDE, from * STRIDE + STRIDE), to * STRIDE);
}
