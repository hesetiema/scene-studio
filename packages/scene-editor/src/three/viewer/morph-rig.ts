import * as THREE from "three";
import type { MorphTargetInfo } from "../../runtime/runtime-contract";

export type { MorphTargetInfo };

export interface MorphRigOptions {
  /** Content roots (document objects only — never the rig's own furniture). */
  roots: () => readonly THREE.Object3D[];
  /** Track names written by the clip in flight; empty when nothing plays. */
  activeTrackNames: () => readonly string[];
}

export interface MorphRig {
  list(): MorphTargetInfo[];
  /** Set one weight; returns `false` when the channel is absent or animated. */
  setInfluence(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean;
}

type MorphMesh = THREE.Mesh & {
  morphTargetInfluences?: number[];
  morphTargetDictionary?: Record<string, number> | null;
};

function isMorphMesh(object: THREE.Object3D): object is MorphMesh {
  const mesh = object as MorphMesh;
  return mesh.isMesh === true && Array.isArray(mesh.morphTargetInfluences);
}

function nameOfTarget(mesh: MorphMesh, index: number): string {
  for (const [key, value] of Object.entries(mesh.morphTargetDictionary ?? {})) {
    // GLTFLoader fills unnamed targets with their index as the key; those are
    // not names, so they fall through to the readable placeholder.
    if (value === index && key !== String(index)) return key;
  }
  return `Target ${index + 1}`;
}

function morphMeshesOf(root: THREE.Object3D): MorphMesh[] {
  const meshes: MorphMesh[] = [];
  root.traverse((child) => {
    if (isMorphMesh(child)) meshes.push(child);
  });
  return meshes;
}

function objectIdOf(object: THREE.Object3D): string {
  const id = object.userData?.objectId;
  return typeof id === "string" ? id : "";
}

/**
 * glTF morph targets as a flat, addressable list.
 *
 * Meshes are addressed by `(objectId, meshIndex)`, not by uuid: a host stores
 * what it showed in a panel, and a reload keeps the traversal order while uuids
 * change. Everything is re-derived per call (a slider drag costs one traversal
 * of the content) so a swapped asset can never serve a stale list.
 */
export function createMorphRig(options: MorphRigOptions): MorphRig {
  const findRoot = (objectId: string): THREE.Object3D | undefined =>
    options.roots().find((candidate) => objectIdOf(candidate) === objectId);

  /** Nodes whose morph channels the playing clip writes (`<node>.property`). */
  const drivenNodes = (): Set<string> => {
    const nodes = new Set<string>();
    for (const trackName of options.activeTrackNames()) {
      const dot = trackName.indexOf(".");
      if (dot > 0) nodes.add(trackName.slice(0, dot));
    }
    return nodes;
  };

  return {
    list(): MorphTargetInfo[] {
      const driven = drivenNodes();
      const out: MorphTargetInfo[] = [];
      for (const root of options.roots()) {
        const objectId = objectIdOf(root);
        if (!objectId) continue;
        morphMeshesOf(root).forEach((mesh, meshIndex) => {
          const influences = mesh.morphTargetInfluences ?? [];
          const isDriven = mesh.name !== "" && driven.has(mesh.name);
          for (let targetIndex = 0; targetIndex < influences.length; targetIndex += 1) {
            out.push({
              objectId,
              meshIndex,
              meshName: mesh.name,
              targetIndex,
              name: nameOfTarget(mesh, targetIndex),
              influence: influences[targetIndex] ?? 0,
              driven: isDriven,
            });
          }
        });
      }
      return out;
    },

    setInfluence(
      objectId: string,
      meshIndex: number,
      targetIndex: number,
      value: number,
    ): boolean {
      if (!Number.isFinite(value)) return false;
      const root = findRoot(objectId);
      if (!root) return false;
      const mesh = morphMeshesOf(root)[meshIndex];
      const influences = mesh?.morphTargetInfluences;
      if (!mesh || !influences) return false;
      if (targetIndex < 0 || targetIndex >= influences.length) return false;
      // An animated channel is rewritten by the mixer on the next frame.
      if (mesh.name !== "" && drivenNodes().has(mesh.name)) return false;
      influences[targetIndex] = Math.min(Math.max(value, 0), 1);
      return true;
    },
  };
}
