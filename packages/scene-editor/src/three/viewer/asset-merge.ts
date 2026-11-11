import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Static batching *inside* one asset instance.
 *
 * Draw-call batching (`instancing-rig.ts`) only folds primitives that share a
 * geometry; a glTF of 200 chairs modelled as 200 separate meshes still costs
 * 200 draw calls because no two of them are instanced copies. What they do
 * share is the material, so the fix is a static merge: bake each mesh's
 * transform into its geometry and concatenate everything that uses one material
 * into a single buffer.
 *
 * This is deliberately **not** object-model-preserving like instancing is. It
 * is applied only where identity has no meaning:
 *
 * - the asset has no animation clips (a clip would target nodes that no longer
 *   have their own mesh);
 * - the asset declares no `KHR_materials_variants` (a variant switch rewrites
 *   `mesh.material` per node, and there are no per-node meshes left);
 * - per mesh: no skinning, no morph targets, no children, one opaque material.
 *
 * Picking is unaffected: every node of an asset instance already reports the
 * *document* object id (`tagSceneObject`), so a hit on the merged mesh resolves
 * to the same object a hit on any of its parts did.
 *
 * The returned handle owns the new buffers and knows how to put the original
 * subtree back, which is what keeps `remove()` and undo releasing resources
 * exactly once.
 */
export interface AssetMergeHandle {
  /** Merged drawables created. */
  readonly merged: number;
  /** Source meshes folded into them. */
  readonly folded: number;
  /** Put the original meshes back and dispose the merged buffers. */
  restore(): void;
}

export interface AssetMergeOptions {
  /** Fewest meshes worth merging (default 2). */
  minGroupSize?: number;
}

interface Member {
  mesh: THREE.Mesh;
  parent: THREE.Object3D;
  index: number;
}

interface Merged {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  members: Member[];
}

/** Attribute layout + indexing, so `mergeGeometries` cannot see a mismatch. */
function layoutKey(geometry: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const name of Object.keys(geometry.attributes).sort()) {
    const attribute = geometry.attributes[name]!;
    parts.push(`${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}`);
  }
  parts.push(geometry.index ? "indexed" : "plain");
  return parts.join(",");
}

function hasMorphTargets(mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry) return false;
  const morph = (geometry as THREE.BufferGeometry & {
    morphAttributes?: Record<string, unknown[]>;
  }).morphAttributes;
  if (!morph) return false;
  return Object.values(morph).some((list) => Array.isArray(list) && list.length > 0);
}

function eligible(mesh: THREE.Mesh): boolean {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) return false;
  if (mesh.children.length > 0) return false;
  if (!mesh.geometry) return false;
  if (Array.isArray(mesh.material)) return false;
  const material = mesh.material as THREE.Material | undefined;
  if (!material) return false;
  // One merged call has one draw order: per-mesh alpha sorting is gone.
  if (material.transparent === true) return false;
  if (material.opacity !== undefined && material.opacity < 1) return false;
  if (hasMorphTargets(mesh)) return false;
  if (Object.keys(mesh.geometry.attributes).length === 0) return false;
  return true;
}

export function mergeAssetMeshes(
  root: THREE.Object3D,
  options: AssetMergeOptions = {},
): AssetMergeHandle | null {
  const minGroupSize = Math.max(2, Math.trunc(options.minGroupSize ?? 2));
  // Baked transforms are relative to the instance root, so the instance's own
  // transform cancels out and a later move of the document object still works.
  root.updateWorldMatrix(true, true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();

  const groups = new Map<string, Member[]>();
  root.traverse((child) => {
    if (child === root) return;
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true || !eligible(mesh)) return;
    const parent = mesh.parent;
    if (!parent) return;
    const material = mesh.material as THREE.Material;
    // Material *identity*, not a fingerprint: the glTF loader already gives
    // primitives that reference one material the same instance, and merging two
    // materials that merely look alike would be a guess.
    const key = `${material.uuid}|${layoutKey(mesh.geometry)}`;
    const bucket = groups.get(key);
    const member: Member = {
      mesh,
      parent,
      index: parent.children.indexOf(mesh),
    };
    if (bucket) bucket.push(member);
    else groups.set(key, [member]);
  });

  const created: Merged[] = [];
  for (const members of groups.values()) {
    if (members.length < minGroupSize) continue;

    const pieces: THREE.BufferGeometry[] = [];
    for (const member of members) {
      const piece = member.mesh.geometry.clone();
      relative.multiplyMatrices(toRoot, member.mesh.matrixWorld);
      piece.applyMatrix4(relative);
      pieces.push(piece);
    }
    // `null` means the attribute sets disagreed despite the layout key (a
    // `morphAttributes` difference, a mismatched draw range): leave the group
    // exactly as it is rather than risk a corrupted buffer.
    const geometry = mergeGeometries(pieces);
    for (const piece of pieces) piece.dispose();
    if (!geometry) continue;

    const source = members[0]!.mesh;
    const mesh = new THREE.Mesh(geometry, source.material);
    mesh.name = `${root.name || "asset"}:merged`;
    // Same tags as the parts, so `picker.ts` resolves the document object.
    mesh.userData = { ...source.userData };
    mesh.castShadow = members.some((member) => member.mesh.castShadow);
    mesh.receiveShadow = members.some((member) => member.mesh.receiveShadow);
    mesh.renderOrder = source.renderOrder;

    for (const member of members) member.parent.remove(member.mesh);
    root.add(mesh);
    created.push({ mesh, geometry, members });
  }

  if (created.length === 0) return null;

  let restored = false;
  const folded = created.reduce((total, entry) => total + entry.members.length, 0);
  root.updateMatrixWorld(true);

  return {
    merged: created.length,
    folded,
    restore(): void {
      if (restored) return;
      restored = true;
      for (const entry of created) {
        entry.mesh.removeFromParent();
        // The merged buffer is ours; the material belongs to the asset cache.
        entry.geometry.dispose();
        for (const member of entry.members) {
          if (member.mesh.parent) continue;
          const index = Math.min(member.index, member.parent.children.length);
          member.parent.children.splice(index, 0, member.mesh);
          member.mesh.parent = member.parent;
        }
      }
    },
  };
}
