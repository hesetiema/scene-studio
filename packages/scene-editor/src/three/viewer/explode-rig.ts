import * as THREE from "three";
import type { SceneObjectDTO } from "../../core/document/schema";
import type { ObjectStore } from "./object-store";

interface Baseline {
  /** Document positions — the restore point at factor 0. */
  positions: Map<string, THREE.Vector3>;
  /** World-space bounding-box centre per object — the direction source. */
  centers: Map<string, THREE.Vector3>;
  sceneCenter: THREE.Vector3;
  spread: number;
}

const FALLBACK_DIRECTIONS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
];

export interface ExplodeRig {
  setFactor(value: number): void;
  readonly factor: number;
  /** New document: drop the baseline and restore every object to factor 0. */
  reset(): void;
  dispose(): void;
}

export interface ExplodeRigOptions {
  store: ObjectStore;
  /** Document objects (positions are the baseline); `[]` before the first load. */
  getObjects: () => readonly SceneObjectDTO[];
  /** Repaint request; call sites render through their normal path. */
  onInvalidate: () => void;
}

/**
 * Component explode (`explode`, 0..1).
 *
 * The offset is a runtime-only preview: object transforms come from the
 * document (always the baseline), so the factor is idempotent, never fights
 * the gizmo or the undo stack, and restores exactly at 0.
 *
 * Writes go through `store.applyTransform` on purpose: it is the one path that
 * calls `batcher.markDirty`, without which the `InstancedMesh` matrices — and
 * therefore the *visible* instances — would stay at the un-exploded pose.
 */
export function createExplodeRig(options: ExplodeRigOptions): ExplodeRig {
  const { store, getObjects } = options;
  let factor = 0;
  let baseline: Baseline | null = null;

  const objectsById = (): readonly SceneObjectDTO[] => getObjects();

  /**
   * (Re)build the baseline. Directions are measured from *un-exploded* poses:
   * `reset()` runs at factor 0 (document load), and a rebuild triggered by an
   * object-set change first snaps everyone back to their document positions.
   */
  const rebuild = (): Baseline | null => {
    const dtos = objectsById();
    if (dtos.length === 0) return null;

    const positions = new Map<string, THREE.Vector3>();
    const centers = new Map<string, THREE.Vector3>();
    const bounds = new THREE.Box3();
    const objectBox = new THREE.Box3();

    for (const dto of dtos) {
      positions.set(dto.id, new THREE.Vector3(...dto.position));
      const object = store.get(dto.id);
      if (!object) continue;
      objectBox.setFromObject(object);
      if (objectBox.isEmpty()) continue;
      centers.set(dto.id, objectBox.getCenter(new THREE.Vector3()));
      bounds.union(objectBox);
    }

    if (centers.size === 0) return null;

    const size = bounds.getSize(new THREE.Vector3());
    return {
      positions,
      centers,
      sceneCenter: bounds.getCenter(new THREE.Vector3()),
      spread: Math.max(size.x, size.y, size.z, 0.5) * 0.45,
    };
  };

  const restore = (): void => {
    if (!baseline) return;
    for (const [id, base] of baseline.positions) {
      const object = store.get(id);
      if (!object) continue;
      store.applyTransform(id, {
        position: [base.x, base.y, base.z],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: [object.scale.x, object.scale.y, object.scale.z],
      });
    }
  };

  const currentKey = (): string => objectsById().map((dto) => dto.id).join("|");

  return {
    setFactor(value: number): void {
      if (!Number.isFinite(value)) return;
      const next = THREE.MathUtils.clamp(value, 0, 1);
      // 0 → 0 is a no-op even without a baseline: an element re-asserting a
      // missing `explode` attribute after load must not trigger a full
      // rebuild (that walk is O(objects × bounds) and it is exactly what
      // regressed the perf page's first-interactive budget).
      if (next === factor) return;

      if (!baseline) {
        baseline = rebuild();
        if (!baseline) return;
      } else if (baseline.positions.size !== objectsById().length) {
        // Objects mounted/removed since the baseline: restore, re-measure.
        restore();
        baseline = rebuild();
        if (!baseline) return;
      }

      factor = next;
      const dtos = objectsById();
      for (let i = 0; i < dtos.length; i += 1) {
        const dto = dtos[i]!;
        const object = store.get(dto.id);
        if (!object) continue;
        const base = baseline.positions.get(dto.id);
        if (!base) continue;

        const center = baseline.centers.get(dto.id);
        const direction = center
          ? center.clone().sub(baseline.sceneCenter)
          : new THREE.Vector3();
        if (direction.lengthSq() < 1e-6) {
          const fallback = FALLBACK_DIRECTIONS[i % FALLBACK_DIRECTIONS.length];
          if (fallback) direction.copy(fallback);
        }

        const offset = direction.normalize().multiplyScalar(baseline.spread * factor);
        store.applyTransform(dto.id, {
          position: [base.x + offset.x, base.y + offset.y, base.z + offset.z],
          rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
          scale: [object.scale.x, object.scale.y, object.scale.z],
        });
      }
      options.onInvalidate();
    },
    get factor(): number {
      return factor;
    },
    reset(): void {
      restore();
      baseline = null;
      factor = 0;
    },
    dispose(): void {
      this.reset();
    },
  };
}
