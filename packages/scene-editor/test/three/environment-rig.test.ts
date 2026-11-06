import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  DEFAULT_IBL_INTENSITY,
  createEnvironmentRig,
} from "../../src/three/viewer/environment-rig";
import type { EnvironmentView } from "../../src/three/viewer/environment-rig";

function makeView(overrides: Partial<EnvironmentView> = {}): EnvironmentView {
  return { background: null, gridVisible: true, iblIntensity: 1, ...overrides };
}

describe("createEnvironmentRig (IBL)", () => {
  it("accepts a preset switch without a GPU context", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, makeView(), {
      renderer: { render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
    });

    expect(() => rig.setPreset("neutral")).not.toThrow();
    expect(() => rig.setPreset("room")).not.toThrow();
    // No WebGL renderer → no probe is generated, and the view is untouched.
    expect(scene.environment).toBeNull();
    expect(rig.readView().iblIntensity).toBe(1);
    rig.dispose();
  });

  it("reports the studio key direction and follows preset switches", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, makeView(), {
      renderer: { render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
      preset: "neutral",
    });

    const neutral = rig.keyDirection();
    // Key softbox sits front-left and high in our own neutral studio.
    expect(neutral[0]).toBeLessThan(0);
    expect(neutral[1]).toBeGreaterThan(0);
    expect(neutral[2]).toBeGreaterThan(0);
    expect(Math.hypot(...neutral)).toBeCloseTo(1, 5);

    // `RoomEnvironment` is dominated by its overhead mainLight.
    rig.setPreset("room");
    expect(rig.keyDirection()[1]).toBeGreaterThan(0.99);
    rig.dispose();
  });

  it("defaults to the document iblIntensity and reports it back", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, makeView({ iblIntensity: 1.5 }));
    expect(rig.readView().iblIntensity).toBe(1.5);
    rig.dispose();
  });

  it("falls back to DEFAULT_IBL_INTENSITY when the document omits it", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, { background: null, gridVisible: true });
    expect(rig.readView().iblIntensity).toBe(DEFAULT_IBL_INTENSITY);
    rig.dispose();
  });

  it("disables image-based lighting at 0 without loading a map", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, makeView({ iblIntensity: 0 }));
    expect(scene.environment).toBeNull();
    expect(rig.readView().iblIntensity).toBe(0);
    rig.dispose();
  });

  it("never generates a map for a renderer that is not WebGL", () => {
    const scene = new THREE.Scene();
    const onEnvironmentReady = vi.fn();
    const rig = createEnvironmentRig(scene, makeView({ iblIntensity: 1 }), {
      renderer: { render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
      onEnvironmentReady,
    });
    expect(scene.environment).toBeNull();
    expect(onEnvironmentReady).not.toHaveBeenCalled();
    rig.dispose();
  });

  it("round-trips background, grid and intensity through applyView", () => {
    const scene = new THREE.Scene();
    const rig = createEnvironmentRig(scene, makeView());

    rig.applyView({ background: "#123456", gridVisible: false, iblIntensity: 2 });
    const view = rig.readView();
    expect(view.background).toBe("#123456");
    expect(view.gridVisible).toBe(false);
    expect(view.iblIntensity).toBe(2);

    rig.applyView({ background: null, gridVisible: true, iblIntensity: 0 });
    expect(rig.readView().background).toBeNull();
    expect(rig.readView().gridVisible).toBe(true);
    expect(scene.environment).toBeNull();
    rig.dispose();
  });
});
