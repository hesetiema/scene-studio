import * as THREE from "three";
import type { AdditionalLightDTO, ViewState } from "../../core/document/schema";
import { toHex } from "./color";

export type LightingView = ViewState["lights"];

export interface LightingRig {
  readonly lights: readonly THREE.Light[];
  readView(): LightingView;
  applyView(view: LightingView): void;
  dispose(): void;
}

/** A light plus the target object it was given (directional / spot only). */
interface BuiltLight {
  light: THREE.Light;
  target?: THREE.Object3D;
}

const DEFAULT_SPOT_ANGLE = Math.PI / 3;

function vec3(source: THREE.Vector3): [number, number, number] {
  return [source.x, source.y, source.z];
}

function makeTarget([x, y, z]: readonly [number, number, number]): THREE.Object3D {
  const target = new THREE.Object3D();
  target.position.set(x, y, z);
  return target;
}

/** No standalone lights. */
function buildAdditional(dto: AdditionalLightDTO): BuiltLight {
  switch (dto.kind) {
    case "directional": {
      const light = new THREE.DirectionalLight(new THREE.Color(dto.color), dto.intensity);
      const [x, y, z] = dto.position;
      light.position.set(x, y, z);
      // Only carry a target object when the document declared one, so a
      // round-trip through `readView()` cannot invent a field.
      if (dto.target === undefined) return { light };
      const target = makeTarget(dto.target);
      light.target = target;
      return { light, target };
    }
    case "point": {
      const light = new THREE.PointLight(
        new THREE.Color(dto.color),
        dto.intensity,
        dto.distance ?? 0,
        dto.decay ?? 2,
      );
      const [x, y, z] = dto.position;
      light.position.set(x, y, z);
      return { light };
    }
    case "spot": {
      const light = new THREE.SpotLight(
        new THREE.Color(dto.color),
        dto.intensity,
        dto.distance ?? 0,
        dto.angle ?? DEFAULT_SPOT_ANGLE,
        dto.penumbra ?? 0,
        dto.decay ?? 2,
      );
      const [x, y, z] = dto.position;
      light.position.set(x, y, z);
      if (dto.target === undefined) return { light };
      const target = makeTarget(dto.target);
      light.target = target;
      return { light, target };
    }
    case "hemisphere": {
      const light = new THREE.HemisphereLight(
        new THREE.Color(dto.skyColor),
        new THREE.Color(dto.groundColor),
        dto.intensity,
      );
      return { light };
    }
  }
}

/** Reverse of {@link buildAdditional}; keeps the round-trip lossless. */
function readAdditional(light: THREE.Light, target?: THREE.Object3D): AdditionalLightDTO {
  if ((light as THREE.DirectionalLight).isDirectionalLight) {
    return {
      kind: "directional",
      color: toHex(light.color),
      intensity: light.intensity,
      position: vec3(light.position),
      ...(target ? { target: vec3(target.position) } : {}),
    };
  }
  if ((light as THREE.SpotLight).isSpotLight) {
    const spot = light as THREE.SpotLight;
    return {
      kind: "spot",
      color: toHex(light.color),
      intensity: light.intensity,
      position: vec3(light.position),
      angle: spot.angle,
      penumbra: spot.penumbra,
      distance: spot.distance,
      decay: spot.decay,
      ...(target ? { target: vec3(target.position) } : {}),
    };
  }
  if ((light as THREE.PointLight).isPointLight) {
    const point = light as THREE.PointLight;
    return {
      kind: "point",
      color: toHex(light.color),
      intensity: light.intensity,
      position: vec3(light.position),
      distance: point.distance,
      decay: point.decay,
    };
  }
  const hemi = light as THREE.HemisphereLight;
  return {
    kind: "hemisphere",
    skyColor: toHex(hemi.color),
    groundColor: toHex(hemi.groundColor),
    intensity: hemi.intensity,
  };
}

/**
 * Ambient + directional rig plus optional extra lights (reference:
 * `addLights` / `updateLights`). Engine state only — lights are persisted
 * through `view`, never the document (D3/D22).
 *
 * Extra lights are rebuilt on every `applyView` rather than diffed: the list is
 * small and view changes are user-scale events, so a rebuild cannot drift.
 */
export function createLightingRig(scene: THREE.Scene, initial: LightingView): LightingRig {
  const ambient = new THREE.AmbientLight(
    new THREE.Color(initial.ambient.color),
    initial.ambient.intensity,
  );
  const directional = new THREE.DirectionalLight(
    new THREE.Color(initial.directional.color),
    initial.directional.intensity,
  );
  const [dx, dy, dz] = initial.directional.position;
  directional.position.set(dx, dy, dz);
  scene.add(ambient, directional);

  let extra: BuiltLight[] = [];

  const releaseExtras = (): void => {
    for (const built of extra) {
      scene.remove(built.light);
      if (built.target) scene.remove(built.target);
      built.light.dispose();
    }
    extra = [];
  };

  const buildExtras = (dtos: readonly AdditionalLightDTO[]): void => {
    releaseExtras();
    for (const dto of dtos) {
      const built = buildAdditional(dto);
      scene.add(built.light);
      if (built.target) scene.add(built.target);
      extra.push(built);
    }
  };

  buildExtras(initial.additional ?? []);

  return {
    get lights(): readonly THREE.Light[] {
      return [ambient, directional, ...extra.map((built) => built.light)];
    },
    readView(): LightingView {
      const additional = extra.map((built) => readAdditional(built.light, built.target));
      return {
        ambient: {
          color: toHex(ambient.color),
          intensity: ambient.intensity,
        },
        directional: {
          color: toHex(directional.color),
          intensity: directional.intensity,
          position: [directional.position.x, directional.position.y, directional.position.z],
        },
        // Omitted when empty, so a scene without extras serialises exactly as v2 did.
        ...(additional.length > 0 ? { additional } : {}),
      };
    },
    applyView(view: LightingView): void {
      ambient.color.set(view.ambient.color);
      ambient.intensity = view.ambient.intensity;
      directional.color.set(view.directional.color);
      directional.intensity = view.directional.intensity;
      const [x, y, z] = view.directional.position;
      directional.position.set(x, y, z);
      buildExtras(view.additional ?? []);
    },
    dispose(): void {
      releaseExtras();
      scene.remove(ambient, directional);
      ambient.dispose();
      directional.dispose();
    },
  };
}
