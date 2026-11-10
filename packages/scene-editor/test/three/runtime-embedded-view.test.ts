// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { AssetCache } from "../../src/assets/asset-cache";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";
import { createDefaultViewState } from "../../src/core/document/default-view";

type MorphMesh = THREE.Mesh & {
  morphTargetInfluences: number[];
  morphTargetDictionary: Record<string, number>;
};

function stubRenderer(): RendererHandle {
  return { render() {}, setSize() {}, setPixelRatio() {}, dispose() {} };
}

function morphMesh(name: string, targets: string[]): MorphMesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry()) as MorphMesh;
  mesh.name = name;
  mesh.morphTargetInfluences = targets.map(() => 0);
  mesh.morphTargetDictionary = Object.fromEntries(targets.map((t, i) => [t, i]));
  return mesh;
}

function assetScene(options: { camera?: boolean } = {}) {
  const group = new THREE.Group();
  group.name = "Asset";
  group.add(morphMesh("Morph", ["Smile", "Blink"]));
  if (options.camera !== false) {
    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 100);
    camera.name = "Detail";
    camera.position.set(1, 2, 8);
    camera.lookAt(0, 0, 0);
    group.add(camera);
  }
  return group;
}

function assetDoc(clips: THREE.AnimationClip[] = []): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    view: createDefaultViewState(),
    sceneId: "s-cam",
    revision: 0,
    objects: [
      {
        id: "asset-1",
        type: "mesh",
        name: "Asset",
        assetId: "a1",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
  };
}

async function makeRuntime(options: { camera?: boolean; clips?: THREE.AnimationClip[] } = {}) {
  const scene = assetScene(options);
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: stubRenderer,
    enableControls: false,
    assetCache: new AssetCache(async () => ({
      scene,
      ...(options.clips ? { animations: options.clips } : {}),
    })),
  });
  await runtime.loadDocument(assetDoc(options.clips));
  return { runtime, scene };
}

describe("ThreeRuntime embedded cameras", () => {
  it("lists the asset's cameras and looks through one", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.cameras).toEqual(["Detail"]);
    expect(runtime.cameraName).toBeNull();

    expect(runtime.setCameraByName("Detail")).toBe(true);
    expect(runtime.cameraName).toBe("Detail");
    // Pose and FOV come from the authored camera.
    expect(runtime.camera.position.toArray()).toEqual([1, 2, 8]);
    expect(runtime.camera.fov).toBeCloseTo(37);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(runtime.camera.quaternion);
    expect(forward.z).toBeLessThan(0);
  });

  it("remembers a name set before the asset loaded", async () => {
    const scene = assetScene();
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: stubRenderer,
      enableControls: false,
      assetCache: new AssetCache(async () => ({ scene })),
    });

    expect(runtime.setCameraByName("Detail")).toBe(false);
    await runtime.loadDocument(assetDoc());
    expect(runtime.cameraName).toBe("Detail");
  });

  it("restores the orbit view when the camera is released", async () => {
    const { runtime } = await makeRuntime();
    const before = runtime.camera.position.clone();

    runtime.setCameraByName("Detail");
    expect(runtime.camera.position.toArray()).not.toEqual(before.toArray());

    expect(runtime.setCameraByName(null)).toBe(true);
    expect(runtime.cameraName).toBeNull();
    expect(runtime.camera.position.toArray()).toEqual(before.toArray());
    // Releasing twice is a no-op, not an error.
    expect(runtime.setCameraByName(null)).toBe(false);
  });

  it("falls back to the orbit view when the asset carrying the camera is gone", async () => {
    const { runtime } = await makeRuntime();
    runtime.setCameraByName("Detail");

    await runtime.loadDocument({ ...assetDoc(), objects: [] });
    expect(runtime.cameras).toEqual([]);
    expect(runtime.cameraName).toBeNull();
  });
});

describe("ThreeRuntime morph targets", () => {
  it("lists channels with names and weights, and writes them", async () => {
    const { runtime } = await makeRuntime();
    const listed = runtime.morphTargets;

    expect(listed.map((entry) => entry.name)).toEqual(["Smile", "Blink"]);
    expect(listed.every((entry) => entry.objectId === "asset-1")).toBe(true);
    expect(listed.every((entry) => entry.driven === false)).toBe(true);

    expect(runtime.setMorphInfluence("asset-1", 0, 0, 0.65)).toBe(true);
    expect(runtime.morphTargets[0]?.influence).toBeCloseTo(0.65);
  });

  it("refuses channels a playing clip drives", async () => {
    const clip = new THREE.AnimationClip("Pose", 1, [
      new THREE.NumberKeyframeTrack("Morph.morphTargetInfluences", [0, 1], [0, 1]),
    ]);
    const { runtime } = await makeRuntime({ clips: [clip] });

    expect(runtime.morphTargets[0]?.driven).toBe(false);
    expect(runtime.playAnimation("asset-1", 0)).toBe(true);
    try {
      expect(runtime.morphTargets.every((entry) => entry.driven)).toBe(true);
      expect(runtime.setMorphInfluence("asset-1", 0, 0, 0.5)).toBe(false);
    } finally {
      runtime.pauseAnimations();
    }

    // Paused playback no longer owns the channel.
    expect(runtime.morphTargets.every((entry) => entry.driven)).toBe(false);
    expect(runtime.setMorphInfluence("asset-1", 0, 0, 0.5)).toBe(true);
  });
});
