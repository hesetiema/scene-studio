// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPicker } from "../../src/three/picker";

function canvas(): HTMLCanvasElement {
  return {
    clientWidth: 100,
    clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  } as never;
}

/** Camera at +Z looking at the origin: NDC (0,0) hits the +Z face. */
function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** 64×64 sphere ≈ 8 000 triangles: above the default threshold. */
function heavySphere(id: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  mesh.userData = { objectId: id, sceneObjectId: id };
  mesh.updateMatrixWorld(true);
  return mesh;
}

const CENTER = { clientX: 50, clientY: 50 };

describe("picker BVH acceleration", () => {
  it("leaves small meshes on three's own raycast path", async () => {
    const small = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    small.userData = { sceneObjectId: "box" };
    small.updateMatrixWorld(true);

    const picker = createPicker({ camera: camera(), canvas: canvas() });
    picker.setTargets([small]);
    await picker.ready();

    expect(picker.pick(CENTER)).toBe("box");
    expect(picker.accelerated).toBe(0);
    expect(small.raycast).toBe(THREE.Mesh.prototype.raycast);
    picker.dispose();
  });

  it("gives a heavy mesh a BVH and the same answer", async () => {
    const ball = heavySphere("ball");
    const plain = createPicker({
      camera: camera(),
      canvas: canvas(),
      // Disable the acceleration entirely: the reference answer.
      bvhThreshold: Number.POSITIVE_INFINITY,
    });
    plain.setTargets([ball]);
    const reference = plain.pickDetail(CENTER)!;
    plain.dispose();

    const picker = createPicker({ camera: camera(), canvas: canvas(), bvhThreshold: 0 });
    picker.setTargets([ball]);

    // Nothing is built until the picker is used…
    expect(picker.accelerated).toBe(0);
    expect(ball.geometry.boundsTree).toBeUndefined();
    // …and `ready()` is the explicit way to make the first pick fast.
    await picker.ready();
    expect(picker.accelerated).toBe(1);
    expect(picker.pick(CENTER)).toBe("ball");
    expect(ball.raycast).not.toBe(THREE.Mesh.prototype.raycast);

    const accelerated = picker.pickDetail(CENTER)!;
    expect(accelerated.id).toBe(reference.id);
    // Same surface point and normal as the brute-force path.
    expect(accelerated.position[2]).toBeCloseTo(reference.position[2]!, 4);
    // Faceted sphere: the centre face points within a few milliradians of +Z.
    expect(accelerated.normal[2]).toBeGreaterThan(0.99);
    picker.dispose();
  });

  it("still misses where the mesh is not", async () => {
    const ball = heavySphere("ball");
    const picker = createPicker({ camera: camera(), canvas: canvas(), bvhThreshold: 0 });
    picker.setTargets([ball]);
    await picker.ready();

    expect(picker.pick({ clientX: 0, clientY: 0 })).toBeNull();
    picker.dispose();
  });

  it("shares one tree between instances of the same geometry", async () => {
    const a = heavySphere("a");
    const b = heavySphere("b");
    b.geometry = a.geometry;
    b.position.set(0.5, 0, 0);
    b.updateMatrixWorld(true);

    const picker = createPicker({ camera: camera(), canvas: canvas(), bvhThreshold: 0 });
    picker.setTargets([a, b]);
    await picker.ready();

    expect(picker.accelerated).toBe(2);
    expect(a.geometry.boundsTree).toBeTruthy();
    expect(b.geometry.boundsTree).toBe(a.geometry.boundsTree);
    picker.dispose();
  });

  it("skips skinned, morphed and instanced meshes", async () => {
    const base = heavySphere("base");
    const skinned = new THREE.SkinnedMesh(base.geometry, base.material);
    skinned.userData = { sceneObjectId: "skinned" };
    const morphed = new THREE.Mesh(base.geometry.clone(), base.material);
    morphed.geometry.morphAttributes.position = [morphed.geometry.attributes.position!.clone()];
    morphed.userData = { sceneObjectId: "morphed" };
    const instanced = new THREE.InstancedMesh(base.geometry, base.material, 1);
    instanced.userData = { sceneObjectId: "instanced" };

    const picker = createPicker({
      camera: camera(),
      canvas: canvas(),
      bvhThreshold: 0,
      // Only the acceleration pass matters here; a skeleton-less SkinnedMesh
      // cannot be raycast, which is the point of excluding it.
      raycast: () => [],
    });
    picker.setTargets([skinned, morphed, instanced]);
    await picker.ready();

    expect(picker.accelerated).toBe(0);
    picker.dispose();
  });

  it("restores every mesh and detaches the trees on dispose", async () => {
    const ball = heavySphere("ball");
    const original = ball.raycast;
    const picker = createPicker({ camera: camera(), canvas: canvas(), bvhThreshold: 0 });
    picker.setTargets([ball]);
    await picker.ready();
    expect(ball.geometry.boundsTree).toBeTruthy();

    picker.dispose();

    expect(ball.raycast).toBe(original);
    expect(ball.geometry.boundsTree).toBeNull();
    expect(picker.accelerated).toBe(0);
  });

  it("does not build trees when the picker is never used", () => {
    const ball = heavySphere("ball");
    const build = vi.fn(() => new THREE.BoxGeometry());
    // A geometry whose `index` getter would explode if a BVH read it.
    Object.defineProperty(ball.geometry, "index", {
      get() {
        build();
        return null;
      },
    });

    const picker = createPicker({ camera: camera(), canvas: canvas(), bvhThreshold: 0 });
    picker.setTargets([ball]);

    expect(build).not.toHaveBeenCalled();
    picker.dispose();
  });
});
