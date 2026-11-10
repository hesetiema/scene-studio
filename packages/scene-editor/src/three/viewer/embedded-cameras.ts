import * as THREE from "three";

/** One camera authored inside an asset (glTF `node.camera`). */
export interface EmbeddedCamera {
  /** Unique, human-readable label; glTF camera names are optional and may repeat. */
  name: string;
  camera: THREE.Camera;
}

/**
 * Cameras carried by the loaded content, in traversal order.
 *
 * glTF cameras are ordinary scene-graph nodes, so a viewer can borrow their
 * pose. `name` is never empty: an unnamed camera becomes `Camera 1`, `Camera 2`,
 * … and repeat names get a ` (2)` suffix — the host addresses them by string, so
 * they have to be unique.
 */
export function collectEmbeddedCameras(
  roots: readonly THREE.Object3D[],
): EmbeddedCamera[] {
  const found: THREE.Camera[] = [];
  for (const root of roots) {
    root.traverse((object) => {
      if ((object as THREE.Camera).isCamera === true) found.push(object as THREE.Camera);
    });
  }

  const used = new Set<string>();
  return found.map((camera, index) => {
    const base = camera.name.trim() || `Camera ${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(name);
    return { name, camera };
  });
}

/**
 * Point on the camera's view axis that the orbit controls should pivot around.
 *
 * A glTF camera stores an orientation, not a look-at target; OrbitControls
 * re-derives orientation from `target` on every update, so the target has to sit
 * on the forward ray or the first orbit drag would swing the view. The content
 * centre is projected onto that ray; if the camera looks away from it, a short
 * distance keeps the pivot just in front of the lens.
 */
export function orbitTargetFor(camera: THREE.Camera, centre: THREE.Vector3): THREE.Vector3 {
  const position = camera.getWorldPosition(new THREE.Vector3());
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  const along = centre.clone().sub(position).dot(forward);
  const distance = Math.max(along, position.distanceTo(centre) * 0.25, 0.001);
  return position.addScaledVector(forward, distance);
}
