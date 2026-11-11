import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { MaterialDTO, PrimitiveGeometry, SceneObjectDTO } from "../../core/document/schema";
import {
  createSharedResourcePool,
  primitiveSignature,
  type SharedResourcePool,
} from "./shared-resources";

export interface PlaceholderObject {
  object: THREE.Mesh;
  dispose: () => void;
}

/** Apply the document transform to a live object (D3: transforms are data). */
export function applyDtoTransform(object: THREE.Object3D, dto: SceneObjectDTO): void {
  const [px, py, pz] = dto.position;
  const [rx, ry, rz] = dto.rotation;
  const [sx, sy, sz] = dto.scale;
  object.position.set(px, py, pz);
  object.rotation.set(rx, ry, rz);
  object.scale.set(sx, sy, sz);
}

/**
 * Tag the root *and* every child so picking works on asset groups (D1 eval).
 * `objectId` is the runtime key; `sceneObjectId` is the public picker contract.
 */
export function tagSceneObject(object: THREE.Object3D, objectId: string): void {
  object.traverse((child) => {
    child.userData = { ...child.userData, objectId, sceneObjectId: objectId };
  });
}

/** Clone a cached asset root into a document object (D11/D12). */
export function instantiateAsset(root: unknown, dto: SceneObjectDTO): THREE.Object3D {
  const source = root as THREE.Object3D | null;
  if (!source || typeof source.traverse !== "function") {
    throw new Error(`Asset "${dto.assetId ?? dto.id}" did not yield an Object3D`);
  }

  // Skinned assets need the skeleton re-bound to the cloned bones; a plain
  // `Object3D.clone` keeps pointing at the cached skeleton, so animation drives
  // bones that no longer exist in the scene graph.
  const instance = hasSkinnedMesh(source) ? cloneSkinned(source) : source.clone(true);

  applyDtoTransform(instance, dto);
  tagSceneObject(instance, dto.id);
  return instance;
}

function hasSkinnedMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

/**
 * Hierarchy-only node: no drawables, no GPU resources to dispose. It exists so
 * `parentId` can group transforms without a mesh at the root (D3: transforms
 * are data).
 */
export function createGroupObject(dto: SceneObjectDTO): THREE.Group {
  const group = new THREE.Group();
  group.name = dto.name;
  applyDtoTransform(group, dto);
  tagSceneObject(group, dto.id);
  return group;
}

/** Default surface for objects without an explicit material. */
const BASE_COLOR = 0x4f8ef7;

/**
 * Every placeholder and primitive starts on the same base material, so the pool
 * has exactly one entry for it. A document material never lands here: the store
 * applies it through `applyMaterialOverride`, which clones per object.
 */
const BASE_MATERIAL_KEY = "MeshStandardMaterial|#4f8ef7";

/**
 * Pool used when a caller does not pass one. Only reached by direct users of
 * `createPrimitiveObject`; the runtime always supplies its own, so a document
 * teardown can release everything it allocated.
 */
let fallbackPool: SharedResourcePool | null = null;

function poolFor(pool?: SharedResourcePool): SharedResourcePool {
  if (pool) return pool;
  fallbackPool ??= createSharedResourcePool();
  return fallbackPool;
}

/** Document geometry → live BufferGeometry. Every default is documented here. */
export function createPrimitiveGeometry(geometry: PrimitiveGeometry): THREE.BufferGeometry {
  switch (geometry.kind) {
    case "box":
      return new THREE.BoxGeometry(
        geometry.width ?? 1,
        geometry.height ?? 1,
        geometry.depth ?? 1,
        geometry.widthSegments ?? 1,
        geometry.heightSegments ?? 1,
        geometry.depthSegments ?? 1,
      );
    case "sphere":
      return new THREE.SphereGeometry(
        geometry.radius ?? 0.5,
        geometry.widthSegments ?? 32,
        geometry.heightSegments ?? 16,
      );
    case "cylinder":
      return new THREE.CylinderGeometry(
        geometry.radiusTop ?? 0.5,
        geometry.radiusBottom ?? 0.5,
        geometry.height ?? 1,
        geometry.radialSegments ?? 32,
      );
    case "cone":
      return new THREE.ConeGeometry(
        geometry.radius ?? 0.5,
        geometry.height ?? 1,
        geometry.radialSegments ?? 32,
      );
    case "torus":
      return new THREE.TorusGeometry(
        geometry.radius ?? 0.5,
        geometry.tube ?? 0.2,
        geometry.radialSegments ?? 16,
        geometry.tubularSegments ?? 48,
      );
    case "plane":
      return new THREE.PlaneGeometry(
        geometry.width ?? 1,
        geometry.height ?? 1,
        geometry.widthSegments ?? 1,
        geometry.heightSegments ?? 1,
      );
    case "capsule":
      return new THREE.CapsuleGeometry(
        geometry.radius ?? 0.5,
        geometry.length ?? 1,
        geometry.capSegments ?? 4,
        geometry.radialSegments ?? 16,
      );
    case "icosahedron":
      return new THREE.IcosahedronGeometry(geometry.radius ?? 0.5, geometry.detail ?? 0);
  }
}

/**
 * Write only the fields the document set — a colour-only override must not
 * reset a GLB's roughness with a default.
 *
 * Parameter support is structural: a material that has no `roughness` (basic,
 * unlit) simply keeps its own value instead of being upgraded.
 */
export function applyMaterialFields(material: THREE.Material, dto: MaterialDTO): void {
  const surface = material as Partial<THREE.MeshStandardMaterial>;

  if (dto.color !== undefined) surface.color?.set(dto.color);
  if (dto.roughness !== undefined && surface.roughness !== undefined) {
    surface.roughness = dto.roughness;
  }
  if (dto.metalness !== undefined && surface.metalness !== undefined) {
    surface.metalness = dto.metalness;
  }
  if (dto.emissive !== undefined) surface.emissive?.set(dto.emissive);
  if (dto.emissiveIntensity !== undefined && surface.emissiveIntensity !== undefined) {
    surface.emissiveIntensity = dto.emissiveIntensity;
  }
  if (dto.opacity !== undefined) {
    material.opacity = dto.opacity;
    // One flag, derived — a document cannot ask for a transparent object that
    // still occludes what is behind it.
    material.transparent = dto.opacity < 1;
    material.depthWrite = dto.opacity >= 1;
  }
  if (dto.flatShading !== undefined && surface.flatShading !== undefined) {
    surface.flatShading = dto.flatShading;
  }
  if (dto.wireframe !== undefined && surface.wireframe !== undefined) {
    surface.wireframe = dto.wireframe;
  }

  material.needsUpdate = true;
}

/**
 * Handle for one applied override. `restore()` is idempotent and is what makes
 * "clear the material" and "set a different one" expressible as a command.
 */
export interface MaterialOverrideHandle {
  /** Clones currently mounted on the object; emptied after `restore()`. */
  readonly materials: readonly THREE.Material[];
  /** Put the original materials back and dispose the clones. */
  restore(): void;
}

/**
 * Apply a document material to every mesh under `object`, cloning each material
 * first: `Object3D.clone()` shares material instances with the cached asset, so
 * writing in place would repaint every other instance of that asset.
 *
 * The returned handle owns the clones and knows the originals — the caller
 * decides when to put them back.
 */
export function applyMaterialOverride(
  object: THREE.Object3D,
  dto: MaterialDTO,
): MaterialOverrideHandle {
  const applied: THREE.Material[] = [];
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.material === undefined) return;

    originals.set(mesh, mesh.material);
    const clone = (material: THREE.Material): THREE.Material => {
      const copy = material.clone();
      applyMaterialFields(copy, dto);
      applied.push(copy);
      return copy;
    };

    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(clone)
      : clone(mesh.material);
  });

  let restored = false;

  return {
    materials: applied,
    restore(): void {
      if (restored) return;
      restored = true;
      for (const [mesh, materials] of originals) mesh.material = materials;
      for (const material of applied) material.dispose();
      applied.length = 0;
    },
  };
}

/**
 * Procedural object: geometry from the document plus a base material.
 *
 * The document's `material` is deliberately *not* applied here — the object
 * store routes every object (primitive, placeholder, asset) through
 * `applyMaterialOverride` so one code path owns override and restore.
 *
 * Geometry and base material come from `resources`, so a 5 000-box document
 * allocates one buffer and one material instead of 5 000 of each. `dispose()`
 * therefore releases references rather than freeing outright.
 */
export function createPrimitiveObject(
  dto: SceneObjectDTO,
  resources?: SharedResourcePool,
): PlaceholderObject {
  const pool = poolFor(resources);
  const geometry = pool.geometry(`geometry:${primitiveSignature(dto.geometry)}`, () =>
    dto.geometry ? createPrimitiveGeometry(dto.geometry) : new THREE.BoxGeometry(1, 1, 1),
  );
  const material = pool.material(
    `material:${BASE_MATERIAL_KEY}`,
    () => new THREE.MeshStandardMaterial({ color: BASE_COLOR }),
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = dto.name;
  applyDtoTransform(mesh, dto);
  tagSceneObject(mesh, dto.id);

  return {
    object: mesh,
    dispose(): void {
      pool.release(geometry);
      pool.release(material);
    },
  };
}

/** Deterministic box used when no assetId / asset cache is available. */
export function createPlaceholderObject(
  dto: SceneObjectDTO,
  resources?: SharedResourcePool,
): PlaceholderObject {
  const pool = poolFor(resources);
  // Same signature as a default `box` primitive: both build `BoxGeometry(1,1,1)`,
  // so the placeholder and a `{ kind: "box" }` object share one buffer.
  const geometry = pool.geometry(`geometry:${primitiveSignature(undefined)}`, () =>
    new THREE.BoxGeometry(1, 1, 1),
  );
  const material = pool.material(
    `material:${BASE_MATERIAL_KEY}`,
    () => new THREE.MeshStandardMaterial({ color: BASE_COLOR }),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = dto.name;
  applyDtoTransform(mesh, dto);
  tagSceneObject(mesh, dto.id);

  return {
    object: mesh,
    dispose(): void {
      pool.release(geometry);
      pool.release(material);
    },
  };
}
