import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { SceneObjectDTO } from "../../core/document/schema";

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

/** Deterministic box used when no assetId / asset cache is available. */
export function createPlaceholderObject(dto: SceneObjectDTO): PlaceholderObject {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x4f8ef7 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = dto.name;
  applyDtoTransform(mesh, dto);
  tagSceneObject(mesh, dto.id);

  return {
    object: mesh,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
