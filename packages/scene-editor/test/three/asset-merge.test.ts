import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { mergeAssetMeshes } from "../../src/three/viewer/asset-merge";

const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x4f8ef7 });

function box(x: number, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, 0);
  mesh.userData = { objectId: "asset-1", sceneObjectId: "asset-1" };
  return mesh;
}

function meshesIn(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh === true) found.push(child as THREE.Mesh);
  });
  return found;
}

describe("mergeAssetMeshes", () => {
  it("folds same-material leaves into one mesh and keeps their placement", () => {
    const root = new THREE.Group();
    const nested = new THREE.Group();
    nested.position.set(0, 5, 0);
    root.add(box(0), box(2), box(4), nested);
    nested.add(box(0), box(2));
    root.updateMatrixWorld(true);

    const handle = mergeAssetMeshes(root)!;

    expect(handle).not.toBeNull();
    expect(handle.merged).toBe(1);
    expect(handle.folded).toBe(5);
    const meshes = meshesIn(root);
    expect(meshes).toHaveLength(1);

    const merged = meshes[0]!;
    expect(merged.geometry.attributes.position!.count).toBe(5 * 24);
    const bounds = merged.geometry.boundingBox ?? merged.geometry.computeBoundingBox();
    const box3 = bounds ?? merged.geometry.boundingBox!;
    // Nested meshes were baked at their world position, not flattened to origin.
    expect(box3.min.x).toBeCloseTo(-0.5, 5);
    expect(box3.max.x).toBeCloseTo(4.5, 5);
    expect(box3.min.y).toBeCloseTo(-0.5, 5);
    expect(box3.max.y).toBeCloseTo(5.5, 5);
    // Picking still resolves the document object through the tags.
    expect(merged.userData.sceneObjectId).toBe("asset-1");
    expect(merged.material).toBe(material);
    handle.restore();
  });

  it("leaves a single mesh alone", () => {
    const root = new THREE.Group();
    root.add(box(0));
    root.updateMatrixWorld(true);

    expect(mergeAssetMeshes(root)).toBeNull();
    expect(meshesIn(root)).toHaveLength(1);
  });

  it("never merges across materials", () => {
    const root = new THREE.Group();
    const other = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const second = new THREE.Mesh(geometry, other);
    root.add(box(0), second);
    root.updateMatrixWorld(true);

    expect(mergeAssetMeshes(root)).toBeNull();
    expect(meshesIn(root)).toHaveLength(2);
  });

  it("skips skinned, morphing, transparent and articulated meshes", () => {
    const root = new THREE.Group();
    root.add(box(0), box(2));

    const skinned = new THREE.SkinnedMesh(geometry, material);
    skinned.position.set(4, 0, 0);
    const morphGeometry = geometry.clone();
    morphGeometry.morphAttributes.position = [geometry.attributes.position!.clone()];
    const morphing = new THREE.Mesh(morphGeometry, material);
    morphing.position.set(6, 0, 0);
    const translucent = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0x00ff00, transparent: true }),
    );
    translucent.position.set(8, 0, 0);
    const withChild = new THREE.Mesh(geometry, material);
    withChild.position.set(10, 0, 0);
    withChild.add(new THREE.Mesh(geometry, material));
    root.add(skinned, morphing, translucent, withChild);
    root.updateMatrixWorld(true);

    const handle = mergeAssetMeshes(root)!;

    // The two plain boxes fold, plus the *child* of the articulated mesh (a leaf
    // in its own right); the parent keeps its own draw call either way.
    expect(handle.folded).toBe(3);
    const remaining = meshesIn(root);
    expect(remaining).toContain(skinned);
    expect(remaining).toContain(morphing);
    expect(remaining).toContain(translucent);
    expect(remaining).toContain(withChild);
    // The leaf under it folded away (safe: an animated asset is never merged at
    // all, so nothing drives the parent in a way the child would have followed).
    expect(withChild.children).toHaveLength(0);
    handle.restore();
    expect(withChild.children).toHaveLength(1);
  });

  it("restores the original tree and frees only the buffers it created", () => {
    const root = new THREE.Group();
    const first = box(0);
    const second = box(2);
    root.add(first, second);
    root.updateMatrixWorld(true);

    const handle = mergeAssetMeshes(root)!;
    const mergedGeometry = meshesIn(root)[0]!.geometry;
    const dispose = vi.spyOn(mergedGeometry, "dispose");
    const disposeSource = vi.spyOn(geometry, "dispose");

    handle.restore();

    expect(dispose).toHaveBeenCalledTimes(1);
    // Source buffers belong to the asset cache, not to the merge.
    expect(disposeSource).not.toHaveBeenCalled();
    expect(root.children).toContain(first);
    expect(root.children).toContain(second);
    expect(first.parent).toBe(root);
    expect(meshesIn(root)).toHaveLength(2);

    // Idempotent: a second restore must not re-add duplicates.
    handle.restore();
    expect(meshesIn(root)).toHaveLength(2);
  });
});
