// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createCameraRig, type OrbitControlsLike } from "../../src/three/viewer/camera-rig";

interface ControlsHarness {
  orbit: OrbitControlsLike & {
    enablePan: boolean;
    enableZoom: boolean;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
  };
  emit: (type: string) => void;
}

function makeControls(): ControlsHarness {
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
  return {
    orbit,
    emit: (type) => {
      for (const handler of listeners.get(type) ?? []) handler();
    },
  };
}

function makeRig() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  const onRender = vi.fn();
  const onInteractionEnd = vi.fn();
  const rig = createCameraRig({
    camera,
    domElement: {} as HTMLElement,
    onRender,
    onInteractionEnd,
  });
  const { orbit, emit } = makeControls();
  return { camera, rig, orbit, emit, onRender, onInteractionEnd };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CameraRig controls policy", () => {
  it("applies limits set before the addon mounts (degrees → radians)", () => {
    const { rig, orbit } = makeRig();

    rig.applyControls({
      pan: false,
      zoom: false,
      limits: { theta: [-45, 45], phi: [10, 170], radius: [2, 20] },
    });
    rig.mount(orbit);

    expect(orbit.enablePan).toBe(false);
    expect(orbit.enableZoom).toBe(false);
    expect(orbit.minAzimuthAngle).toBeCloseTo(-Math.PI / 4);
    expect(orbit.maxAzimuthAngle).toBeCloseTo(Math.PI / 4);
    expect(orbit.minPolarAngle).toBeCloseTo((10 * Math.PI) / 180);
    expect(orbit.maxPolarAngle).toBeCloseTo((170 * Math.PI) / 180);
    expect(orbit.minDistance).toBe(2);
    expect(orbit.maxDistance).toBe(20);
  });

  it("re-applies the policy to a live addon and re-renders", () => {
    const { rig, orbit, onRender } = makeRig();
    rig.mount(orbit);
    onRender.mockClear();

    rig.applyControls({ zoom: false });

    expect(orbit.enableZoom).toBe(false);
    expect(onRender).toHaveBeenCalled();
  });

  it("keeps a late mount from resetting the policy", () => {
    const { rig, orbit } = makeRig();
    rig.mount(orbit);
    rig.applyControls({ pan: false });

    const second = makeControls();
    rig.mount(second.orbit);

    expect(second.orbit.enablePan).toBe(false);
  });
});

describe("CameraRig damping", () => {
  function stubFrames() {
    const queue: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    return { queue, cancel };
  }

  /** Rig whose render nudges the camera, so the controls report a change. */
  function makeDampedRig(changesToEmit: number) {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    const { orbit, emit } = makeControls();
    let remaining = 0;
    const onRender = vi.fn(() => {
      if (remaining > 0) {
        remaining -= 1;
        emit("change");
      }
    });
    const rig = createCameraRig({
      camera,
      domElement: {} as HTMLElement,
      onRender,
      onInteractionEnd: vi.fn(),
    });
    rig.mount(orbit);
    rig.applyControls({ damping: 0.3 });
    remaining = changesToEmit;
    return { rig, orbit, emit, onRender, camera };
  }

  it("hands the factor to OrbitControls and reports it as enabled", () => {
    const { rig, orbit } = makeRig();
    rig.applyControls({ damping: 0.2 });
    rig.mount(orbit);

    expect(orbit.enableDamping).toBe(true);
    expect(orbit.dampingFactor).toBe(0.2);
  });

  it("turns damping off when the factor is zero or removed", () => {
    const { rig, orbit } = makeRig();
    rig.applyControls({ damping: 0.2 });
    rig.mount(orbit);
    rig.applyControls({ damping: 0 });

    expect(orbit.enableDamping).toBe(false);
  });

  it("keeps rendering after the gesture until the inertia dies", () => {
    const { queue } = stubFrames();
    const { emit } = makeDampedRig(1);

    emit("end");
    expect(queue).toHaveLength(1);

    // The frame still moves the camera, so the loop asks for another one.
    queue.shift()!(0);
    expect(queue).toHaveLength(1);

    // This one finds it settled: no change, no next frame.
    queue.shift()!(0);
    expect(queue).toHaveLength(0);
  });

  it("stops the settle loop immediately when a new drag starts", () => {
    const { queue, cancel } = stubFrames();
    const { rig, emit } = makeDampedRig(5);

    emit("end");
    const inFlight = queue.shift()!;

    emit("start");
    expect(cancel).toHaveBeenCalledTimes(1);

    // A frame already queued must not revive the loop during the drag.
    inFlight(0);
    expect(queue).toHaveLength(0);
  });

  it("drops the frame loop while inactive and picks it up on resume", () => {
    const { queue, cancel } = stubFrames();
    const { rig } = makeRig();

    rig.setAutoRotate({ enabled: true, degreesPerSecond: 90, delayMs: 0 });
    expect(queue).toHaveLength(1);

    rig.setActive(false);
    expect(cancel).toHaveBeenCalledTimes(1);

    const inFlight = queue.shift()!;
    inFlight(1000); // a late frame must not spin the camera while paused
    expect(queue).toHaveLength(0);

    rig.setActive(true);
    expect(queue).toHaveLength(1);
  });
});

describe("CameraRig auto-rotate", () => {
  function stubFrames() {
    const queue: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.spyOn(performance, "now").mockReturnValue(0);
    return { queue, cancel };
  }

  it("yaws the camera around the target at the requested degrees/second", () => {
    const { queue } = stubFrames();
    const { rig, camera, onRender } = makeRig();

    rig.setAutoRotate({ enabled: true, degreesPerSecond: 90, delayMs: 0 });
    expect(queue).toHaveLength(1);

    // 1 s later, clamped to a 0.1 s step → 9° of yaw.
    queue.shift()!(1000);

    expect(camera.position.x).toBeCloseTo(10 * Math.sin(Math.PI / 20), 4);
    expect(camera.position.z).toBeCloseTo(10 * Math.cos(Math.PI / 20), 4);
    expect(onRender).toHaveBeenCalled();
    expect(queue).toHaveLength(1);
  });

  it("pauses during a gesture and honours the idle delay afterwards", () => {
    const { queue } = stubFrames();
    const { rig, camera, orbit, emit, onInteractionEnd } = makeRig();
    rig.mount(orbit);

    rig.setAutoRotate({ enabled: true, degreesPerSecond: 90, delayMs: 2000 });

    emit("start");
    // A tick during the drag ends the loop instead of nudging the camera.
    queue.shift()!(1000);
    expect(camera.position.x).toBeCloseTo(0);
    expect(queue).toHaveLength(0);

    emit("end");
    expect(onInteractionEnd).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);

    queue.shift()!(1500); // still inside the 2 s idle window
    expect(camera.position.x).toBeCloseTo(0);

    queue.shift()!(2500); // idling is over
    expect(camera.position.x).toBeGreaterThan(0.5);
  });

  it("stops the loop when disabled or disposed", () => {
    const { queue, cancel } = stubFrames();
    const { rig, camera } = makeRig();

    rig.setAutoRotate({ enabled: true, degreesPerSecond: 90, delayMs: 0 });
    rig.setAutoRotate(null);
    expect(cancel).toHaveBeenCalledTimes(1);

    // A stale frame fired after disable must not keep the turntable alive.
    queue.shift()!(1000);
    expect(camera.position.x).toBeCloseTo(0);

    rig.setAutoRotate({ enabled: true, degreesPerSecond: 90, delayMs: 0 });
    const pending = queue.shift()!;
    rig.dispose();
    expect(cancel).toHaveBeenCalledTimes(2);

    pending(2000);
    expect(camera.position.x).toBeCloseTo(0);
  });

  it("defaults to model-viewer's 30°/s when the rate is not finite", () => {
    const { queue } = stubFrames();
    const { rig, camera } = makeRig();

    rig.setAutoRotate({ enabled: true, degreesPerSecond: Number.NaN });
    queue.shift()!(1000);

    // 30°/s × 0.1 s step = 3°.
    expect(camera.position.x).toBeCloseTo(10 * Math.sin((3 * Math.PI) / 180), 4);
  });
});
