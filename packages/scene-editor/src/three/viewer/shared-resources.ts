import * as THREE from "three";
import type { PrimitiveGeometry } from "../../core/document/schema";

/**
 * Reference-counted sharing for placeholder geometry and materials.
 *
 * A document with 5 000 identical boxes used to allocate 5 000 `BoxGeometry`
 * instances and 5 000 `MeshStandardMaterial` instances — tens of MB of JS heap
 * that never reached the GPU, because draw-call batching had already moved
 * every proxy off the rendered layer. Sharing costs one `Map` lookup per object
 * and removes almost all of it.
 *
 * The pool is keyed by *content signature* (`primitiveSignature` for geometry,
 * material fields for materials), not by identity: two objects built from the
 * same document geometry point at the same `BufferGeometry`. Ownership is a
 * refcount, so the resource lives exactly as long as its last member.
 *
 * ### What this changes for a host
 *
 * - `object.geometry` / `object.material` may be shared with other objects.
 *   Mutating one in place (`geometry.attributes.position…`, `material.color…`)
 *   is visible everywhere it is used. The SDK itself never does: a document
 *   material is applied through `applyMaterialOverride`, which clones first.
 * - `dispose()` on a placeholder releases a reference, not necessarily the
 *   resource. A host that hand-builds its own objects must not dispose the
 *   shared geometry itself; going through the placeholder handle is enough.
 * - The batch rig clones what it needs, so batching and sharing are independent.
 */
export interface SharedResourceStats {
  /** Distinct geometry buffers alive in the pool. */
  geometries: number;
  /** Distinct materials alive in the pool. */
  materials: number;
  /** Sum of live references across geometries and materials (two per object). */
  references: number;
}

export interface SharedResourcePool {
  /**
   * Take (or create) the geometry registered under `key`. Every `geometry()`
   * call must be paired with exactly one `release()`.
   */
  geometry<T extends THREE.BufferGeometry>(key: string, create: () => T): T;
  /** Material counterpart of {@link SharedResourcePool.geometry}. */
  material<T extends THREE.Material>(key: string, create: () => T): T;
  /** Drop one reference; disposes the resource when the last one goes. */
  release(resource: THREE.BufferGeometry | THREE.Material): void;
  stats(): SharedResourceStats;
  /** Dispose everything, ignoring refcounts (runtime teardown). */
  dispose(): void;
}

interface Entry<T> {
  kind: "geometry" | "material";
  key: string;
  refs: number;
  resource: T;
}

type AnyResource = THREE.BufferGeometry | THREE.Material;
type AnyEntry = Entry<THREE.BufferGeometry> | Entry<THREE.Material>;

export function createSharedResourcePool(): SharedResourcePool {
  const geometries = new Map<string, AnyEntry>();
  const materials = new Map<string, AnyEntry>();
  /** resource → entry: `release` is handed the resource, not the signature. */
  const owners = new Map<AnyResource, AnyEntry>();

  function take<T extends AnyResource>(
    kind: "geometry" | "material",
    key: string,
    create: () => T,
  ): T {
    const table = kind === "geometry" ? geometries : materials;
    const existing = table.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.resource as T;
    }
    const resource = create();
    const entry: Entry<T> = { kind, key, refs: 1, resource };
    table.set(key, entry as unknown as AnyEntry);
    owners.set(resource, entry as unknown as AnyEntry);
    return resource;
  }

  function drop(resource: AnyResource): void {
    const entry = owners.get(resource);
    // Unknown or already disposed: a double release must not dispose twice.
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    owners.delete(resource);
    if (entry.kind === "geometry") geometries.delete(entry.key);
    else materials.delete(entry.key);
    resource.dispose();
  }

  return {
    geometry<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
      return take("geometry", key, create);
    },
    material<T extends THREE.Material>(key: string, create: () => T): T {
      return take("material", key, create);
    },
    release(resource: AnyResource): void {
      drop(resource);
    },
    stats(): SharedResourceStats {
      let references = 0;
      for (const entry of geometries.values()) references += entry.refs;
      for (const entry of materials.values()) references += entry.refs;
      return { geometries: geometries.size, materials: materials.size, references };
    },
    dispose(): void {
      for (const entry of geometries.values()) entry.resource.dispose();
      for (const entry of materials.values()) entry.resource.dispose();
      geometries.clear();
      materials.clear();
      owners.clear();
    },
  };
}

/**
 * Content signature for a document primitive.
 *
 * Defaults are resolved here exactly as `createPrimitiveGeometry` resolves them,
 * so `{ kind: "box" }` and `{ kind: "box", width: 1, … }` are one buffer rather
 * than two. Spelled per kind instead of `JSON.stringify`: key order in a host's
 * DTO is not something this module can rely on.
 */
export function primitiveSignature(geometry: PrimitiveGeometry | undefined): string {
  if (!geometry) return "box|1|1|1|1|1|1";
  switch (geometry.kind) {
    case "box":
      return [
        "box",
        geometry.width ?? 1,
        geometry.height ?? 1,
        geometry.depth ?? 1,
        geometry.widthSegments ?? 1,
        geometry.heightSegments ?? 1,
        geometry.depthSegments ?? 1,
      ].join("|");
    case "sphere":
      return [
        "sphere",
        geometry.radius ?? 0.5,
        geometry.widthSegments ?? 32,
        geometry.heightSegments ?? 16,
      ].join("|");
    case "cylinder":
      return [
        "cylinder",
        geometry.radiusTop ?? 0.5,
        geometry.radiusBottom ?? 0.5,
        geometry.height ?? 1,
        geometry.radialSegments ?? 32,
      ].join("|");
    case "cone":
      return [
        "cone",
        geometry.radius ?? 0.5,
        geometry.height ?? 1,
        geometry.radialSegments ?? 32,
      ].join("|");
    case "torus":
      return [
        "torus",
        geometry.radius ?? 0.5,
        geometry.tube ?? 0.2,
        geometry.radialSegments ?? 16,
        geometry.tubularSegments ?? 48,
      ].join("|");
    case "plane":
      return [
        "plane",
        geometry.width ?? 1,
        geometry.height ?? 1,
        geometry.widthSegments ?? 1,
        geometry.heightSegments ?? 1,
      ].join("|");
    case "capsule":
      return [
        "capsule",
        geometry.radius ?? 0.5,
        geometry.length ?? 1,
        geometry.capSegments ?? 4,
        geometry.radialSegments ?? 16,
      ].join("|");
    case "icosahedron":
      return ["icosahedron", geometry.radius ?? 0.5, geometry.detail ?? 0].join("|");
  }
}
