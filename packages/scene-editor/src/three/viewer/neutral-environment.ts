import * as THREE from "three";

export interface NeutralEnvironment {
  scene: THREE.Scene;
  dispose(): void;
}

/** Radiance of the dark surround (grayscale: the probe must not tint anything). */
const SURROUND = 0.02;

/**
 * Where the key softbox sits. Exported because the contact shadow has to fall
 * from the same direction as the IBL's highlight — that is the whole difference
 * against an arbitrary analytic key light.
 */
export const NEUTRAL_KEY_OFFSET = [-2.4, 2.6, 2.4] as const;

/**
 * Procedural stand-in for model-viewer's built-in `neutral` environment.
 *
 * model-viewer generates its neutral IBL from white area lights on a dark gray
 * surround instead of shipping an HDR, so this does the same: three softboxes
 * (key front-left, fill right, rim behind) plus a dim ceiling bounce inside a
 * dark box. Everything is grayscale, which is the whole point — three's
 * `RoomEnvironment` lights a *colored* room, and that warm cast is the color
 * delta against model-viewer.
 *
 * Materials are `MeshBasicMaterial`: `PMREMGenerator.fromScene()` renders the
 * scene with no lights, so an environment probe is authored in radiance, not in
 * lit-pixel terms. Values above 1 are legal here and give the key light its HDR
 * punch.
 */
export function createNeutralEnvironment(): NeutralEnvironment {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];

  const track = <T extends { dispose(): void }>(resource: T): T => {
    disposables.push(resource);
    return resource;
  };

  /** One self-lit panel aimed at the probe origin. */
  const panel = (
    intensity: number,
    position: readonly [number, number, number],
    size: readonly [number, number],
  ): void => {
    const geometry = track(new THREE.PlaneGeometry(size[0], size[1]));
    const material = track(
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        toneMapped: false,
        // Grayscale by construction: R = G = B.
        color: new THREE.Color(intensity, intensity, intensity),
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    // Plane normals start at +Z; aim them at the probe origin.
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };

  // Surround: a large inward-facing box keeps the fill directional and dark,
  // so the softboxes stay the brightest thing the probe sees.
  const surroundGeometry = track(new THREE.BoxGeometry(1, 1, 1));
  const surroundMaterial = track(
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      toneMapped: false,
      color: new THREE.Color(SURROUND, SURROUND, SURROUND),
    }),
  );
  const surround = new THREE.Mesh(surroundGeometry, surroundMaterial);
  surround.scale.setScalar(40);
  scene.add(surround);

  // Radiance is calibrated against irradiance rather than by eye:
  // E ≈ L·A/d², so the numbers below add up to ≈ 2.2 for a surface facing the
  // key — a 0.8-albedo diffuse surface then lands near 0.8 sRGB under ACES at
  // exposure 1, which is where model-viewer's neutral studio sits. Tune here if
  // the reference environment changes.
  // Key (front-left, high) → main highlight and the shadow-side falloff.
  panel(5, NEUTRAL_KEY_OFFSET, [3.2, 3.2]);
  // Fill (right, low) → keeps the shadow side readable without flattening it.
  panel(0.85, [3.2, 0.6, 1.4], [3.2, 3.2]);
  // Rim (behind, high) → separates the silhouette from the background.
  panel(1.6, [0.4, 2.4, -3.2], [2.4, 2.4]);
  // Ceiling bounce → downward faces are not pitch black.
  panel(0.3, [0, 4.2, 0], [6, 6]);

  return {
    scene,
    dispose(): void {
      scene.clear();
      for (const resource of disposables) resource.dispose();
      disposables.length = 0;
    },
  };
}
