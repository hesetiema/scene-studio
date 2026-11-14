import { describe, expect, it } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { viewFingerprint } from "../../src/core/document/view-fingerprint";
import type { ViewState } from "../../src/core/document/schema";

describe("viewFingerprint", () => {
  it("is stable across key insertion order", () => {
    const a = createDefaultViewState();
    // Same view, rebuilt field by field in a different order — this is what the
    // host does when it restores one of its own snapshots.
    const b: ViewState = {
      environment: { ...a.environment },
      lights: {
        directional: { ...a.lights.directional },
        ambient: { ...a.lights.ambient },
      },
      camera: { fov: a.camera.fov, target: a.camera.target, position: a.camera.position },
    };

    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(viewFingerprint(b)).toBe(viewFingerprint(a));
  });

  it("treats an absent optional field and an explicit undefined as the same view", () => {
    const a = createDefaultViewState();
    const b = { ...a, lights: { ...a.lights, additional: undefined } };

    expect(viewFingerprint(b as ViewState)).toBe(viewFingerprint(a));
  });

  it("separates views that differ in one component", () => {
    const a = createDefaultViewState();
    const moved: ViewState = {
      ...a,
      camera: { ...a.camera, position: [a.camera.position[0] + 0.0001, a.camera.position[1], a.camera.position[2]] },
    };

    expect(viewFingerprint(moved)).not.toBe(viewFingerprint(a));
  });

  it("absorbs double noise — the runtime re-derives the pose every frame", () => {
    const a = createDefaultViewState();
    const drifted: ViewState = {
      ...a,
      camera: {
        ...a.camera,
        // The measured shape of the drift: thousands of a unit, 15 decimals down.
        position: [
          a.camera.position[0] + 1e-15,
          a.camera.position[1] - 3e-16,
          a.camera.position[2],
        ],
        target: [a.camera.target[0] + 5e-16, a.camera.target[1], a.camera.target[2]],
      },
    };

    expect(viewFingerprint(drifted)).toBe(viewFingerprint(a));
  });

  it("still reports a real move, well above the quantum", () => {
    const a = createDefaultViewState();
    const nudged: ViewState = {
      ...a,
      camera: { ...a.camera, position: [a.camera.position[0] + 0.001, a.camera.position[1], a.camera.position[2]] },
    };

    expect(viewFingerprint(nudged)).not.toBe(viewFingerprint(a));
  });

  it("survives a JSON round-trip unchanged (fingerprints are comparable across loads)", () => {
    const a = createDefaultViewState();
    const roundTripped = JSON.parse(JSON.stringify(a)) as ViewState;

    expect(viewFingerprint(roundTripped)).toBe(viewFingerprint(a));
  });
});
