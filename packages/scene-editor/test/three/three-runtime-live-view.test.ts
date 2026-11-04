import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";

function makeRenderer() {
  return {
    domElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    },
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeOrbit() {
  const listeners = new Map<string, () => void>();
  const orbit = {
    update: vi.fn(),
    dispose: vi.fn(),
    target: new THREE.Vector3(),
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, fn);
    },
  };
  return { orbit, listeners };
}

function makeRuntime(extra: Record<string, unknown> = {}) {
  return new ThreeRuntime({
    canvas: {} as HTMLCanvasElement,
    rendererFactory: makeRenderer as never,
    enableControls: false,
    ...extra,
  } as never);
}

function makeInteractiveRuntime(extra: Record<string, unknown> = {}) {
  const { orbit, listeners } = makeOrbit();
  const runtime = makeRuntime({
    enableControls: true,
    orbitControlsFactory: () => orbit,
    transformControlsFactory: () => null,
    ...extra,
  });
  return { runtime, listeners };
}

describe("ThreeRuntime live view sampling (D22)", () => {
  it("is off by default", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    runtime.events.on("view-changing", () => {
      throw new Error("must not emit while opted out");
    });

    runtime.camera.position.set(1, 2, 3);
    listeners.get("change")?.();
  });

  it("emits one sample per actual camera move", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    const seen: number[] = [];
    runtime.events.on("view-changing", ({ view }) => seen.push(view.camera.position[0]!));

    runtime.setLiveViewEvents(true);
    runtime.camera.position.set(1, 2, 3);
    listeners.get("change")?.();
    expect(seen).toEqual([1]);

    // Same camera again (e.g. a resize-driven re-render) → no sample.
    listeners.get("change")?.();
    expect(seen).toEqual([1]);

    runtime.camera.position.set(4, 2, 3);
    listeners.get("change")?.();
    expect(seen).toEqual([1, 4]);
  });

  it("seeds on enable so the current view is not re-announced", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    const spy = vi.fn();
    runtime.events.on("view-changing", spy);

    runtime.setLiveViewEvents(true);
    listeners.get("change")?.();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays silent for programmatic applyViewState", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    const spy = vi.fn();
    runtime.setLiveViewEvents(true);
    runtime.events.on("view-changing", spy);

    const view = createDefaultViewState();
    view.camera = { position: [-4, 3, 2], target: [1, 1, 0], fov: 30 };
    runtime.applyViewState(view);
    listeners.get("change")?.();

    expect(spy).not.toHaveBeenCalled();
    expect(runtime.camera.fov).toBe(30);
  });

  it("re-seeds after an applied view so the next gesture is sampled", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    runtime.setLiveViewEvents(true);
    const seen: number[] = [];
    runtime.events.on("view-changing", ({ view }) => seen.push(view.camera.fov));

    const view = createDefaultViewState();
    view.camera = { position: [-4, 3, 2], target: [1, 1, 0], fov: 30 };
    runtime.applyViewState(view);

    runtime.camera.position.set(-3, 3, 2);
    listeners.get("change")?.();
    expect(seen).toEqual([30]);
  });

  it("stops sampling when disabled again", () => {
    const { runtime, listeners } = makeInteractiveRuntime();
    const spy = vi.fn();
    runtime.events.on("view-changing", spy);

    runtime.setLiveViewEvents(true);
    runtime.setLiveViewEvents(false);
    runtime.camera.position.set(9, 9, 9);
    listeners.get("change")?.();

    expect(spy).not.toHaveBeenCalled();
  });
});
