import type { Camera, Intersection, Object3D } from "three";
import { Matrix3, Raycaster, Vector2, Vector3 } from "three";

/** Loaded on demand: most documents are small enough that a BVH never pays. */
type BvhModule = typeof import("three-mesh-bvh");

export interface PickPoint {
  clientX: number;
  clientY: number;
}

export interface PickerOptions {
  /** Camera used for raycasting. */
  camera: Camera;
  /** Canvas used for coordinate normalization. */
  canvas: HTMLCanvasElement;
  /**
   * Optional injected raycast function for tests: receives NDC x,y and returns
   * hits sorted by distance ascending. Defaults to THREE.Raycaster against the
   * provided scene objects via `setTargets`.
   */
  raycast?: (ndcX: number, ndcY: number) => RaycastHit[];
  /**
   * Triangles above which a mesh gets a bounding-volume hierarchy (default
   * 2 000). Below that, three's per-mesh bounding-sphere test already rejects
   * the ray cheaply and a BVH build would cost more than it saves.
   */
  bvhThreshold?: number;
}

export interface RaycastHit {
  object: Object3D;
  distance: number;
  /** World-space intersection point (model-viewer's `positionAndNormalFromPoint`). */
  point?: { x: number; y: number; z: number };
  /** World-space surface normal. */
  normal?: { x: number; y: number; z: number };
}

export interface PickDetail {
  /** Document id of the object under the pointer. */
  id: string;
  position: readonly [number, number, number];
  normal: readonly [number, number, number];
}

export interface Picker {
  pick(point: PickPoint): string | null;
  /** Same raycast as `pick`, but keeps the world-space point + normal. */
  pickDetail(point: PickPoint): PickDetail | null;
  setTargets(objects: Object3D[]): void;
  /**
   * Resolves after the acceleration pass has run for the current targets (or
   * after a failed chunk load). Await it to make the *first* pick fast too;
   * otherwise the chunk arrives in the background and picks use three's own
   * raycast until it does.
   */
  ready(): Promise<void>;
  /** Meshes currently raycast through a BVH (diagnostic / test hook). */
  readonly accelerated: number;
  dispose(): void;
}

const FALLBACK_NORMAL = [0, 1, 0] as const;

/**
 * Trees are keyed by geometry and shared across pickers: an asset's instances
 * clone the same buffers, and two runtimes may show the same asset. A registry
 * (not a per-picker map) is what keeps one picker's `dispose()` from pulling
 * the tree out from under another one.
 */
const treeCache = new WeakMap<object, { tree: object; refs: number }>();

/** Triangles that would be tested by a brute-force raycast. */
function triangleCount(mesh: Object3D): number {
  const geometry = (mesh as { geometry?: { index?: { count: number } | null; attributes?: Record<string, { count: number }> } }).geometry;
  if (!geometry?.attributes?.position) return 0;
  if (geometry.index) return geometry.index.count / 3;
  return geometry.attributes.position.count / 3;
}

/**
 * Whether a BVH would be both correct and worth its memory.
 *
 * Skinned and morphed meshes are excluded: their vertices move, and a tree
 * built once against the bind pose would report hits the geometry no longer
 * has. Instanced meshes are excluded too — the raycast has to be run per
 * instance, which is a different acceleration path.
 */
function bvhEligible(mesh: Object3D): boolean {
  const candidate = mesh as {
    isMesh?: boolean;
    isSkinnedMesh?: boolean;
    isInstancedMesh?: boolean;
    geometry?: { morphAttributes?: Record<string, unknown[]> };
  };
  if (candidate.isMesh !== true) return false;
  if (candidate.isSkinnedMesh === true || candidate.isInstancedMesh === true) return false;
  const morph = candidate.geometry?.morphAttributes;
  if (morph && Object.values(morph).some((list) => Array.isArray(list) && list.length > 0)) {
    return false;
  }
  return true;
}

/**
 * Click picking (P2-T7): maps client coords → NDC → raycast → nearest hit
 * with userData.sceneObjectId. Hits keep their surface point + normal so
 * hotspots can be anchored on the model instead of in screen space.
 *
 * ### Heavy meshes
 *
 * A bounding-sphere test rejects a ray against a far mesh in constant time, so
 * the cost of picking a 100 000-triangle model is *inside* the one mesh the ray
 * does hit. Meshes above `bvhThreshold` triangles therefore get a `MeshBVH`,
 * and their `raycast` is swapped for `acceleratedRaycast` (per mesh, not on
 * `THREE.Mesh.prototype` — an SDK must not patch a peer dependency globally).
 * Trees are built on the first pick rather than at `setTargets`: loading a
 * model is not the moment to spend 20 ms on a structure the user may never
 * need. `raycaster.firstHitOnly` stops each accelerated mesh at its nearest
 * hit, which is all `pick`/`pickDetail` use.
 *
 * The BVH itself is a **dynamic import**, so a viewer that never clicks a heavy
 * model never downloads it (~30 kB gzip) — and the request is only started when
 * the mounted content actually contains a mesh above the threshold. The first
 * pick on a heavy mesh still returns the right answer through three's own
 * raycast; the tree kicks in from the next pick on.
 */
export function createPicker(options: PickerOptions): Picker {
  const { camera, canvas } = options;
  const threshold = Math.max(0, Math.trunc(options.bvhThreshold ?? 2_000));
  let targets: Object3D[] = [];
  const raycaster = new Raycaster();
  // Batched primitives live on their own layer so the camera does not draw the
  // proxy twice (see `instancing-rig.ts`); a pick must still see them.
  raycaster.layers.enableAll();
  const ndc = new Vector2();
  const normalMatrix = new Matrix3();

  /** meshes whose `raycast` is redirected, with the original to put back. */
  const patched = new Map<Object3D, () => void>();
  /** One tree per geometry: asset instances share buffers, so they share BVHs. */
  const trees = new Map<BufferGeometryLike, object>();
  /** The BVH module, once its chunk has arrived. */
  let bvh: BvhModule | null = null;
  /** Resolves after the first acceleration pass (or after a failed import). */
  let readyPromise: Promise<void> | null = null;
  /** The current target set is fully accelerated. */
  let acceleratedForTargets = false;
  /** Cached "does anything here even need a BVH"; reset with the targets. */
  let hasHeavyMesh: boolean | null = null;

  interface BufferGeometryLike {
    boundsTree?: unknown;
    dispose(): void;
  }

  /** Patch the eligible meshes of the current targets; idempotent. */
  function accelerate(): void {
    const module = bvh;
    if (!module || acceleratedForTargets) return;
    acceleratedForTargets = true;

    for (const root of targets) {
      root.traverse((node) => {
        if (patched.has(node)) return;
        if (!bvhEligible(node)) return;
        if (triangleCount(node) < threshold) return;
        const mesh = node as unknown as {
          geometry: BufferGeometryLike;
          raycast: (raycaster: Raycaster, intersects: Intersection[]) => void;
        };
        if (!mesh.geometry) return;

        let tree = trees.get(mesh.geometry);
        if (!tree) {
          let entry = treeCache.get(mesh.geometry);
          if (!entry) {
            try {
              entry = { tree: new module.MeshBVH(mesh.geometry as never), refs: 0 };
            } catch {
              // A geometry without a position attribute (or with a foreign
              // layout) simply keeps three's own raycast.
              return;
            }
            treeCache.set(mesh.geometry, entry);
          }
          entry.refs += 1;
          tree = entry.tree;
          trees.set(mesh.geometry, tree);
        }
        mesh.geometry.boundsTree = tree;
        const original = mesh.raycast;
        mesh.raycast = module.acceleratedRaycast as never;
        patched.set(node, () => {
          mesh.raycast = original;
        });
      });
    }
  }

  /** Start (once) the chunk request and accelerate whatever is mounted now. */
  function ensureAcceleration(): void {
    // A scene of primitives must not download 30 kB of BVH it will never use.
    if (hasHeavyMesh === null) {
      hasHeavyMesh = false;
      for (const root of targets) {
        root.traverse((node) => {
          if (hasHeavyMesh === true) return;
          if (!bvhEligible(node)) return;
          if (triangleCount(node) >= threshold) hasHeavyMesh = true;
        });
        if (hasHeavyMesh) break;
      }
    }
    if (!hasHeavyMesh) return;

    if (readyPromise !== null) {
      // Later calls only matter when the target set changed since the last pass.
      if (bvh) accelerate();
      return;
    }
    readyPromise = (async () => {
      try {
        bvh = await import("three-mesh-bvh");
        accelerate();
      } catch {
        // No chunk (CSP, offline, a bundler that dropped it): stock raycast
        // stays in place and picking keeps working, just slower.
      }
    })();
  }

  const defaultRaycast = (ndcX: number, ndcY: number): RaycastHit[] => {
    ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(ndc, camera);
    // One hit per mesh is all `pick` needs, and it lets the BVH stop early.
    raycaster.firstHitOnly = true;
    const hits = raycaster.intersectObjects(targets, true);
    return hits.map((hit) => {
      // `face.normal` is object-local; the renderer needs it in world space.
      let normal: Vector3 | undefined;
      if (hit.face) {
        normal = hit.face.normal.clone().applyNormalMatrix(
          normalMatrix.getNormalMatrix(hit.object.matrixWorld),
        );
        normal.normalize();
      }
      return {
        object: hit.object,
        distance: hit.distance,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        ...(normal ? { normal: { x: normal.x, y: normal.y, z: normal.z } } : {}),
      };
    });
  };
  const doRaycast = options.raycast ?? defaultRaycast;

  const clientToNdc = (point: PickPoint): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      width: canvas.clientWidth || 1,
      height: canvas.clientHeight || 1,
    };
    const width = rect.width || canvas.clientWidth || 1;
    const height = rect.height || canvas.clientHeight || 1;
    return {
      x: ((point.clientX - rect.left) / width) * 2 - 1,
      y: -((point.clientY - rect.top) / height) * 2 + 1,
    };
  };

  const sortedHits = (point: PickPoint): RaycastHit[] => {
    // The chunk request starts on the first pick, never on load, and a caller
    // that never picks pays nothing for either the chunk or the trees.
    ensureAcceleration();
    const { x, y } = clientToNdc(point);
    return doRaycast(x, y)
      .slice()
      .sort((a, b) => a.distance - b.distance);
  };

  const ownerId = (object: Object3D): string | null => {
    let node: Object3D | null | undefined = object;
    while (node) {
      const id = (node.userData?.sceneObjectId ?? node.userData?.objectId) as
        | string
        | undefined;
      if (id) return id;
      node = (node.parent ?? null) as Object3D | null;
    }
    return null;
  };

  return {
    setTargets(objects: Object3D[]): void {
      targets = objects;
      // Hand the previous meshes their own raycast back before re-evaluating.
      for (const restore of patched.values()) restore();
      patched.clear();
      acceleratedForTargets = false;
      hasHeavyMesh = null;
    },
    pick(point: PickPoint): string | null {
      for (const hit of sortedHits(point)) {
        const id = ownerId(hit.object);
        if (id) return id;
      }
      return null;
    },
    pickDetail(point: PickPoint): PickDetail | null {
      for (const hit of sortedHits(point)) {
        const id = ownerId(hit.object);
        if (!id) continue;
        const position = hit.point ?? { x: 0, y: 0, z: 0 };
        const normal = hit.normal ?? { x: FALLBACK_NORMAL[0], y: FALLBACK_NORMAL[1], z: FALLBACK_NORMAL[2] };
        return {
          id,
          position: [position.x, position.y, position.z],
          normal: [normal.x, normal.y, normal.z],
        };
      }
      return null;
    },
    get accelerated(): number {
      return patched.size;
    },
    ready(): Promise<void> {
      ensureAcceleration();
      return readyPromise ?? Promise.resolve();
    },
    dispose(): void {
      targets = [];
      for (const restore of patched.values()) restore();
      patched.clear();
      // Trees are shared with other pickers (an asset's instances share
      // buffers), so dropping our reference is all this picker may do — the
      // last holder detaches it from the geometry. The BVH is plain JS arrays:
      // there is nothing else to free.
      for (const [geometry, tree] of trees) {
        const entry = treeCache.get(geometry);
        if (!entry) continue;
        entry.refs -= 1;
        if (entry.refs > 0) continue;
        treeCache.delete(geometry);
        if (geometry.boundsTree === tree) geometry.boundsTree = null;
      }
      trees.clear();
      acceleratedForTargets = false;
      hasHeavyMesh = null;
    },
  };
}
