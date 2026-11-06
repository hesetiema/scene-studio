import * as THREE from "three";
import type { ContactShadowDTO } from "../../core/document/schema";

/** model-viewer's default shadow is soft and light; match that expectation. */
const DEFAULT_OPACITY = 0.35;
const SHADOW_MAP_SIZE = 1024;

export interface ContactShadowOptions {
  scene: THREE.Scene;
  /** Real WebGL renderer; stubs have no `shadowMap`, so the rig stays inert. */
  renderer?: unknown;
}

export interface ContactShadowRig {
  /** `settings` undefined or `enabled: false` hides the catch plane. */
  applyView(settings: ContactShadowDTO | undefined, bounds: THREE.Box3): void;
  /**
   * Aim the shadow light. Vector points scene → light, so it is the direction the
   * key light (or the environment's highlight) comes from; normalised here.
   */
  setLightDirection(direction: readonly [number, number, number]): void;
  dispose(): void;
}

/**
 * Soft ground shadow under the content (reference: model-viewer `shadow-intensity`).
 *
 * A `ShadowMaterial` plane catches the key light's shadow map — no post-process
 * depth blur, so it costs one shadow pass and no extra render target. The light's
 * orthographic shadow camera is fitted to the content bounds, otherwise a 1-unit
 * object would spend the whole 1024² map on a few pixels.
 *
 * `shadowMap.enabled` is turned on once and never toggled back: flipping it
 * recompiles every material, which is worse than an idle shadow pass.
 */
export function createContactShadowRig(options: ContactShadowOptions): ContactShadowRig {
  const { scene, renderer } = options;

  /**
   * Shadow-only light. `intensity: 0` keeps it out of the lighting response, but
   * three still renders its shadow map, so the plane receives a shadow without
   * a second key light flattening the IBL (which is what the preview relies on).
   * Owning the light here also keeps `getViewState()` free of it — the document's
   * `view.lights.directional` stays untouched.
   */
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.castShadow = false;
  scene.add(light);

  /** Unit vector scene → light; re-applied whenever the content is re-fitted. */
  const direction = new THREE.Vector3(0.42, 0.82, 0.39).normalize();
  let lightDistance = 10;

  const placeLight = (): void => {
    light.position.copy(direction).multiplyScalar(lightDistance);
  };
  placeLight();

  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShadowMaterial({
    opacity: DEFAULT_OPACITY,
    transparent: true,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(geometry, material);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  plane.visible = false;
  scene.add(plane);

  let shadowMapType: THREE.ShadowMapType | null = null;

  /**
   * `PCFSoftShadowMap` ignores `shadow.radius` — that is the pre-v5 look. Once a
   * document declares `softness`, switch to radius-based PCF so the number is
   * honoured; changing the sampler changes the shader, so materials are flagged
   * for one recompile instead of silently keeping the old filtering.
   */
  const enableShadowMap = (useRadius: boolean): void => {
    light.castShadow = true;
    const gl = renderer as
      | { shadowMap?: { enabled: boolean; type: THREE.ShadowMapType } }
      | null
      | undefined;
    if (!gl?.shadowMap) return;
    gl.shadowMap.enabled = true;

    const next = useRadius ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    if (shadowMapType === next) return;
    const previous = shadowMapType;
    shadowMapType = next;
    gl.shadowMap.type = next;

    if (previous === null) return;
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.needsUpdate = true;
    });
  };

  return {
    applyView(settings: ContactShadowDTO | undefined, bounds: THREE.Box3): void {
      const enabled = settings?.enabled === true;
      plane.visible = enabled;
      if (!enabled) return;

      const softness = settings?.softness;
      material.opacity = settings?.opacity ?? DEFAULT_OPACITY;
      enableShadowMap(softness !== undefined);
      if (softness !== undefined) {
        // 0 → crisp 1-texel PCF, 1 → ~10-texel blur on a 1024² map.
        light.shadow.radius = 1 + softness * 9;
      }

      const empty = bounds.isEmpty();
      const center = empty ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const spanX = empty ? 0 : bounds.max.x - bounds.min.x;
      const spanZ = empty ? 0 : bounds.max.z - bounds.min.z;
      const size = Math.max(spanX, spanZ, 1) * 1.6;

      plane.scale.set(size, size, 1);
      plane.position.set(center.x, settings?.height ?? (empty ? 0 : bounds.min.y), center.z);

      const half = Math.max(size / 2, 1);
      const camera = light.shadow.camera;
      camera.left = -half;
      camera.right = half;
      camera.top = half;
      camera.bottom = -half;
      camera.near = 0.1;
      camera.far = Math.max(half * 8, 20);
      camera.updateProjectionMatrix();
      light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      light.shadow.bias = -0.0005;

      // Keep the light outside the content so the shadow camera sees all of it.
      lightDistance = Math.max(half * 4, 10);
      placeLight();
    },
    setLightDirection(next: readonly [number, number, number]): void {
      const [x, y, z] = next;
      const length = Math.hypot(x, y, z);
      if (!Number.isFinite(length) || length < 1e-6) return;
      direction.set(x / length, y / length, z / length);
      placeLight();
    },
    dispose(): void {
      scene.remove(plane, light);
      geometry.dispose();
      material.dispose();
      light.dispose();
    },
  };
}
