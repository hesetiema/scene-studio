// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { AssetCache } from "../../src/assets/asset-cache";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

function stubRenderer() {
  return {
    domElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    },
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeOrbit() {
  const listeners = new Map<string, Array<() => void>>();
  const orbit = {
    target: new THREE.Vector3(),
    update: vi.fn(),
    dispose: vi.fn(),
    enablePan: true,
    enableZoom: true,
    minDistance: 0,
    maxDistance: Infinity,
    minPolarAngle: 0,
    maxPolarAngle: Math.PI,
    minAzimuthAngle: -Infinity,
    maxAzimuthAngle: Infinity,
    addEventListener: (type: string, handler: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
  };
  const emit = (type: string): void => {
    for (const handler of listeners.get(type) ?? []) handler();
  };
  return { orbit, emit };
}

function makeRuntime(extra: Record<string, unknown> = {}) {
  const { orbit, emit } = makeOrbit();
  const runtime = new ThreeRuntime({
    canvas: {} as HTMLCanvasElement,
    rendererFactory: stubRenderer as never,
    enableControls: true,
    orbitControlsFactory: () => orbit,
    transformControlsFactory: () => null,
    ...extra,
  } as never);
  return { runtime, orbit, emit };
}

function makeDoc(objects: SceneDocument["objects"]): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "s",
    revision: 0,
    objects,
    view: createDefaultViewState(),
  };
}

function assetObject(id: string, assetId: string) {
  return {
    id,
    type: "mesh" as const,
    name: id,
    assetId,
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

describe("ThreeRuntime camera-change event", () => {
  it("reports camera samples without the live-view opt-in", () => {
    const { runtime, emit } = makeRuntime();
    const seen: number[] = [];
    runtime.events.on("camera-change", ({ position }) => seen.push(position[0]));

    runtime.camera.position.set(1, 2, 3);
    emit("change");
    expect(seen).toEqual([1]);

    // Static re-renders (resize, material edits) must not fake a camera move.
    emit("change");
    expect(seen).toEqual([1]);

    runtime.camera.position.set(4, 2, 3);
    emit("change");
    expect(seen).toEqual([1, 4]);
  });

  it("stays silent for programmatic applyViewState", () => {
    const { runtime, emit } = makeRuntime();
    const spy = vi.fn();
    runtime.events.on("camera-change", spy);

    const view = createDefaultViewState();
    view.camera = { position: [-4, 3, 2], target: [1, 1, 0], fov: 30 };
    runtime.applyViewState(view);
    emit("change");

    expect(spy).not.toHaveBeenCalled();
    expect(runtime.camera.fov).toBe(30);
  });
});

describe("ThreeRuntime camera policy", () => {
  it("forwards pointer switches and orbit limits to the controls", () => {
    const { runtime, orbit } = makeRuntime();

    runtime.setCameraControls({
      pan: false,
      zoom: false,
      limits: { theta: [-30, 30], phi: [20, 160], radius: [1, 10] },
    });

    expect(orbit.enablePan).toBe(false);
    expect(orbit.enableZoom).toBe(false);
    expect(orbit.minAzimuthAngle).toBeCloseTo(-Math.PI / 6);
    expect(orbit.maxAzimuthAngle).toBeCloseTo(Math.PI / 6);
    expect(orbit.maxDistance).toBe(10);
  });

  it("accepts auto-rotate and can switch it off again", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.setAutoRotate({ enabled: true, degreesPerSecond: 15 })).not.toThrow();
    expect(() => runtime.setAutoRotate(null)).not.toThrow();
    runtime.flushDisposers();
  });
});

describe("ThreeRuntime animation options", () => {
  function makeAnimationRuntime() {
    const clip = new THREE.AnimationClip("Wave", 2, [
      new THREE.VectorKeyframeTrack(".position[x]", [0, 2], [0, 1]),
    ]);
    const root = new THREE.Group();
    const cache = new AssetCache(async () => ({ scene: root, animations: [clip] }));
    const { runtime } = makeRuntime({ assetCache: cache });
    return runtime;
  }

  it("autoplays the documented clip name once options arrive", async () => {
    const runtime = makeAnimationRuntime();
    await runtime.loadDocument(makeDoc([assetObject("obj-1", "a1")]));

    expect(runtime.animationPlaying).toBe(false);
    runtime.setAnimationOptions({ autoplay: true, clipName: "wave" });
    expect(runtime.animationPlaying).toBe(true);
    expect(runtime.animationDuration).toBeCloseTo(2);
  });

  it("autoplays on the next load when set beforehand", async () => {
    const runtime = makeAnimationRuntime();
    runtime.setAnimationOptions({ autoplay: true });

    await runtime.loadDocument(makeDoc([assetObject("obj-1", "a1")]));
    expect(runtime.animationPlaying).toBe(true);
  });

  it("does not start playback when autoplay is off", async () => {
    const runtime = makeAnimationRuntime();
    await runtime.loadDocument(makeDoc([assetObject("obj-1", "a1")]));

    runtime.setAnimationOptions({ autoplay: false });
    expect(runtime.animationPlaying).toBe(false);
  });
});
