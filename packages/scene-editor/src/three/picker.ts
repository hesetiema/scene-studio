import type { Camera, Object3D } from "three";
import { Matrix3, Raycaster, Vector2, Vector3 } from "three";

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
  dispose(): void;
}

const FALLBACK_NORMAL = [0, 1, 0] as const;

/**
 * Click picking (P2-T7): maps client coords → NDC → raycast → nearest hit
 * with userData.sceneObjectId. Hits keep their surface point + normal so
 * hotspots can be anchored on the model instead of in screen space.
 */
export function createPicker(options: PickerOptions): Picker {
  const { camera, canvas } = options;
  let targets: Object3D[] = [];
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const normalMatrix = new Matrix3();

  const defaultRaycast = (ndcX: number, ndcY: number): RaycastHit[] => {
    ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(ndc, camera);
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
    dispose(): void {
      targets = [];
    },
  };
}
