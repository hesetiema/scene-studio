// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";

function stubRenderer(): RendererHandle {
  return {
    disposed: false,
    render() {},
    setSize() {},
    setPixelRatio() {},
    dispose() {
      this.disposed = true;
    },
  } as RendererHandle & { disposed: boolean };
}

/** A runtime whose camera sits on +Z looking at the origin. */
function runtimeAt(z: number): ThreeRuntime {
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => stubRenderer(),
    enableControls: false,
  });
  runtime.camera.position.set(0, 0, z);
  runtime.camera.lookAt(0, 0, 0);
  runtime.camera.updateMatrixWorld();
  return runtime;
}

const ORIGIN = [0, 0, 0] as const;

describe("ThreeRuntime.projectHotspot", () => {
  it("keeps the projection and adds the facing verdict", () => {
    const runtime = runtimeAt(5);
    const flat = runtime.projectPoint(ORIGIN);
    const hotspot = runtime.projectHotspot(ORIGIN, [0, 0, 1]);

    expect(hotspot.x).toBe(flat.x);
    expect(hotspot.y).toBe(flat.y);
    expect(hotspot.z).toBe(flat.z);
    expect(hotspot.visible).toBe(true);
    // A canvas with no layout is treated as 1x1, so the centre lands at 0.5.
    expect(hotspot.x).toBeCloseTo(0.5);
    expect(hotspot.y).toBeCloseTo(0.5);
  });

  it("faces the camera when the normal points at it", () => {
    const runtime = runtimeAt(5);

    expect(runtime.projectHotspot(ORIGIN, [0, 0, 1]).facingCamera).toBe(true);
    expect(runtime.projectHotspot(ORIGIN, [0, 0, -1]).facingCamera).toBe(false);
  });

  it("tests the signed dot, exactly like the reference", () => {
    // model-viewer never normalises either vector: the sign of the dot is all
    // that matters, so a tiny normal gives the same answer as a unit one.
    const runtime = runtimeAt(5);

    expect(runtime.projectHotspot(ORIGIN, [0, 0, 0.001]).facingCamera).toBe(true);
    expect(runtime.projectHotspot(ORIGIN, [0, 0, -0.001]).facingCamera).toBe(false);
  });

  it("treats a zero-length normal as facing rather than vanishing", () => {
    // `dot === 0` is not `< 0`, so an anchor with no meaningful normal stays put
    // instead of blinking out.
    const runtime = runtimeAt(5);

    expect(runtime.projectHotspot(ORIGIN, [0, 0, 0]).facingCamera).toBe(true);
  });

  it("depends on where the camera is, not just on the normal", () => {
    const front = runtimeAt(5);
    const back = runtimeAt(-5);

    expect(front.projectHotspot(ORIGIN, [0, 0, 1]).facingCamera).toBe(true);
    // Same anchor, same normal, camera on the other side of it.
    expect(back.projectHotspot(ORIGIN, [0, 0, 1]).facingCamera).toBe(false);
  });

  it("reports the anchor itself, not just its normal, as behind the camera", () => {
    const runtime = runtimeAt(5);

    expect(runtime.projectHotspot([0, 0, 9], [0, 0, 1]).visible).toBe(false);
  });
});
