import type { Camera, Object3D } from "three";
import { Raycaster, Vector2 } from "three";

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
}

export interface Picker {
  pick(point: PickPoint): string | null;
  setTargets(objects: Object3D[]): void;
  dispose(): void;
}

/**
 * Click picking (P2-T7): maps client coords → NDC → raycast → nearest hit
 * with userData.sceneObjectId.
 */
export function createPicker(options: PickerOptions): Picker {
  const { camera, canvas } = options;
  let targets: Object3D[] = [];
  const raycaster = new Raycaster();
  const ndc = new Vector2();

  const defaultRaycast = (ndcX: number, ndcY: number): RaycastHit[] => {
    ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(targets, true);
    return hits.map((h) => ({ object: h.object, distance: h.distance }));
  };
  const doRaycast = options.raycast ?? defaultRaycast;

  return {
    setTargets(objects: Object3D[]): void {
      targets = objects;
    },
    pick(point: PickPoint): string | null {
      const rect = canvas.getBoundingClientRect?.() ?? {
        left: 0,
        top: 0,
        width: canvas.clientWidth || 1,
        height: canvas.clientHeight || 1,
      };
      const width = rect.width || canvas.clientWidth || 1;
      const height = rect.height || canvas.clientHeight || 1;
      const ndcX = ((point.clientX - rect.left) / width) * 2 - 1;
      const ndcY = -((point.clientY - rect.top) / height) * 2 + 1;
      const hits = doRaycast(ndcX, ndcY).slice().sort((a, b) => a.distance - b.distance);
      for (const hit of hits) {
        let node: Object3D | null | undefined = hit.object;
        while (node) {
          const id = node.userData?.sceneObjectId as string | undefined;
          if (id) return id;
          node = (node.parent ?? null) as Object3D | null;
        }
      }
      return null;
    },
    dispose(): void {
      targets = [];
    },
  };
}
