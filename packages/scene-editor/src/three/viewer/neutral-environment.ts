import * as THREE from "three";

export interface NeutralEnvironment {
  scene: THREE.Scene;
  dispose(): void;
}

/**
 * Where the key light sits, in probe space — used by the environment rig to
 * point the contact shadow at the same side as the IBL's highlight.
 */
export const NEUTRAL_KEY_OFFSET = [-14, 10, 8] as const;

/**
 * model-viewer's built-in `neutral` environment, reproduced exactly.
 *
 * Why a port instead of our own studio: the reference does not ship an HDR. It
 * *renders* a small scene — a big diffuse room, six white occluder boxes, seven
 * emissive panels and one point light — through a cube camera, then blurs it
 * (σ = 0.04) before using it as the IBL. The soft gradients that make its metals
 * and matte surfaces read the way they do come from that lit-room geometry, not
 * from a hand-placed set of softboxes. An approximation matched its *average*
 * luminance but not the *shape* of the light, which is what the reflections
 * show.
 *
 * The numbers below are the `neutral` table from model-viewer's
 * `EnvironmentScene`, and the capture in `environment-rig.ts` uses the same
 * σ and cube-camera defaults (`pmrem.fromScene(scene, 0.04)` ≈ three's
 * equivalent of model-viewer's cube blur).
 *
 * @license Portions derived from @google/model-viewer (Copyright 2019 Google
 * LLC), licensed under the Apache License, Version 2.0 —
 * https://www.apache.org/licenses/LICENSE-2.0
 */

/** The room: an inward-facing diffuse box the probe sits inside. */
const ROOM = {
  position: [0, 13.2, 0] as const,
  scale: [31.5, 28.5, 31.5] as const,
};

/** White blocks that occlude parts of the panels — they shape the gradients. */
const BOXES = [
  { position: [-10.906, -1, 1.846], rotation: -0.195, scale: [2.328, 7.905, 4.651] },
  { position: [-5.607, -0.754, -0.758], rotation: 0.994, scale: [1.97, 1.534, 3.955] },
  { position: [6.167, -0.16, 7.803], rotation: 0.561, scale: [3.927, 6.285, 3.687] },
  { position: [-2.017, 0.018, 6.124], rotation: 0.333, scale: [2.002, 4.566, 2.064] },
  { position: [2.291, -0.756, -2.621], rotation: -0.286, scale: [1.546, 1.552, 1.496] },
  { position: [-2.193, -0.369, -5.547], rotation: 0.516, scale: [3.875, 3.487, 2.986] },
] as const;

/** Self-lit panels; the last entry is a token glow, kept for parity. */
const PANELS = [
  { intensity: 80, position: [-14, 10, 8], scale: [0.1, 2.5, 2.5] },
  { intensity: 80, position: [-14, 14, -4], scale: [0.1, 2.5, 2.5] },
  { intensity: 23, position: [14, 12, 0], scale: [0.1, 5, 5] },
  { intensity: 16, position: [0, 9, 14], scale: [5, 5, 0.1] },
  { intensity: 80, position: [7, 8, -14], scale: [2.5, 2.5, 0.1] },
  { intensity: 80, position: [-7, 16, -14], scale: [2.5, 2.5, 0.1] },
  { intensity: 1, position: [0, 20, 0], scale: [0.1, 0.1, 0.1] },
] as const;

/** Ceiling bounce: a real point light, so the room itself is lit, not emissive. */
const TOP_LIGHT = { intensity: 400, position: [0.5, 14, 0.5] as const };

export function createNeutralEnvironment(): NeutralEnvironment {
  const scene = new THREE.Scene();
  // The probe sits at the scene origin; the room is shifted down so the model
  // stands on the floor rather than floating at the room's centre plane.
  scene.position.y = -3.5;

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(resource: T): T => {
    disposables.push(resource);
    return resource;
  };

  const geometry = track(new THREE.BoxGeometry());

  const roomMaterial = track(
    new THREE.MeshStandardMaterial({ metalness: 0, side: THREE.BackSide }),
  );
  const boxMaterial = track(new THREE.MeshStandardMaterial({ metalness: 0 }));

  const topLight = new THREE.PointLight(0xffffff, TOP_LIGHT.intensity, 28, 2);
  topLight.position.set(TOP_LIGHT.position[0], TOP_LIGHT.position[1], TOP_LIGHT.position[2]);
  scene.add(topLight);

  const room = new THREE.Mesh(geometry, roomMaterial);
  room.position.set(ROOM.position[0], ROOM.position[1], ROOM.position[2]);
  room.scale.set(ROOM.scale[0], ROOM.scale[1], ROOM.scale[2]);
  scene.add(room);

  for (const box of BOXES) {
    const mesh = new THREE.Mesh(geometry, boxMaterial);
    mesh.position.set(box.position[0], box.position[1], box.position[2]);
    mesh.rotation.set(0, box.rotation, 0);
    mesh.scale.set(box.scale[0], box.scale[1], box.scale[2]);
    scene.add(mesh);
  }

  for (const panel of PANELS) {
    // Grayscale by construction (R = G = B): a probe must not tint the model.
    const material = track(
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(panel.intensity) }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(panel.position[0], panel.position[1], panel.position[2]);
    mesh.scale.set(panel.scale[0], panel.scale[1], panel.scale[2]);
    scene.add(mesh);
  }

  return {
    scene,
    dispose(): void {
      scene.clear();
      for (const resource of disposables) resource.dispose();
      disposables.length = 0;
    },
  };
}
