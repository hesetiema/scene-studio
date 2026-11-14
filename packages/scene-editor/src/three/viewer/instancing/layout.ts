/**
 * Spatial chunk ordering: which member goes into which slot of which chunk.
 *
 * Pure number crunching — no three.js, no scene graph — so the grid heuristic
 * can be tested on its own. The rig reads world positions, calls this, and
 * writes matrices.
 *
 * Why not "the next 256 objects": cutting the admission order into fixed
 * blocks produces slabs that all span the whole scene. Measured: 1 000 boxes,
 * camera in a corner, triangles unchanged at 12 000 — four bounding spheres
 * that all intersect the frustum, i.e. no culling at all. A chunk has to be a
 * *place*, so members are bucketed by world position first.
 */

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Order `items` so consecutive runs of `chunkSize` share a grid cell.
 *
 * Returns `null` when there is nothing to split (one chunk or less): the append
 * order already fills it, and the caller can keep its matrices untouched.
 */
export function planSpatialOrder(
  items: readonly LayoutItem[],
  chunkSize: number,
): string[] | null {
  const count = items.length;
  // One chunk: there is nothing to split, and the append order already fills it.
  if (count <= chunkSize) return null;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const item of items) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.z < minZ) minZ = item.z;
    if (item.x > maxX) maxX = item.x;
    if (item.y > maxY) maxY = item.y;
    if (item.z > maxZ) maxZ = item.z;
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
  return keyed.map((item) => item.id);
}
