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

function makeRuntime(extra: Record<string, unknown> = {}) {
  return new ThreeRuntime({
    canvas: {} as HTMLCanvasElement,
    rendererFactory: makeRenderer as never,
    enableControls: false,
    ...extra,
  } as never);
}

describe("ThreeRuntime view state (D22)", () => {
  it("reports the engine defaults as the initial view", () => {
    expect(makeRuntime().getViewState()).toEqual(createDefaultViewState());
  });

  it("round-trips an applied view", () => {
    const runtime = makeRuntime();
    const view = createDefaultViewState();
    view.camera = { position: [-4, 3, 2], target: [1, 1, 0], fov: 30 };
    view.lights.ambient = { color: "#123456", intensity: 0.9 };
    view.lights.directional = { color: "#654321", intensity: 0.4, position: [1, 2, 3] };
    view.environment = { background: "#0f0f0f", gridVisible: false, iblIntensity: 0 };

    runtime.applyViewState(view);
    expect(runtime.getViewState()).toEqual(view);
    expect(runtime.camera.fov).toBe(30);
    expect(runtime.scene.background).toBeInstanceOf(THREE.Color);
  });

  it("round-trips contact-shadow settings and omits them by default", () => {
    const runtime = makeRuntime();
    expect(runtime.getViewState().environment.contactShadow).toBeUndefined();

    const view = createDefaultViewState();
    view.environment.contactShadow = { enabled: true, opacity: 0.6, height: -1 };
    runtime.applyViewState(view);

    expect(runtime.getViewState()).toEqual(view);
  });

  it("restores a transparent background from null", () => {
    const runtime = makeRuntime();
    const view = createDefaultViewState();
    view.environment.background = "#101010";
    runtime.applyViewState(view);
    expect(runtime.getViewState().environment.background).toBe("#101010");

    view.environment.background = null;
    runtime.applyViewState(view);
    expect(runtime.getViewState().environment.background).toBeNull();
  });

  it("does not emit view-change while applying a view", () => {
    const runtime = makeRuntime();
    const seen: unknown[] = [];
    runtime.events.on("view-change", (payload) => seen.push(payload));
    runtime.applyViewState(createDefaultViewState());
    expect(seen).toEqual([]);
  });

  it("emits view-change exactly once per orbit interaction end", () => {
    const listeners = new Map<string, () => void>();
    const orbit = {
      update: vi.fn(),
      dispose: vi.fn(),
      target: new THREE.Vector3(),
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, fn);
      },
    };
    const runtime = makeRuntime({
      enableControls: true,
      orbitControlsFactory: () => orbit,
      transformControlsFactory: () => null,
    });

    const seen: Array<{ view: ReturnType<typeof createDefaultViewState> }> = [];
    runtime.events.on("view-change", (payload) => seen.push(payload));

    runtime.camera.position.set(1, 2, 3);
    orbit.target.set(0, 1, 0);
    listeners.get("end")?.();

    expect(listeners.has("end")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.view.camera.position).toEqual([1, 2, 3]);
    expect(seen[0]?.view.camera.target).toEqual([0, 1, 0]);
  });
});
