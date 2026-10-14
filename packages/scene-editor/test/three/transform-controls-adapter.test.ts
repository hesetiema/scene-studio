// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createTransformControlsAdapter } from "../../src/three/addons/transform-controls-adapter";
import type { Transform } from "../../src/runtime/runtime-contract";

describe("createTransformControlsAdapter", () => {
  it("maps drag-end to a single TransformCommand-shaped callback (one drag = one command)", () => {
    const from: Transform = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    const to: Transform = {
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    const onStart = vi.fn(() => from);
    const onCommit = vi.fn();
    const fakeControls = {
      addEventListener: vi.fn(),
      dispose: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
      getHelper: () => ({}),
    };
    const adapter = createTransformControlsAdapter({
      controls: fakeControls as never,
      onStart,
      onCommit,
    });

    // simulate three emitting mouseDown (capture from) then mouseUp (commit)
    const mouseDown = fakeControls.addEventListener.mock.calls.find(
      (c) => c[0] === "mouseDown",
    )?.[1] as (() => void) | undefined;
    const mouseUp = fakeControls.addEventListener.mock.calls.find(
      (c) => c[0] === "mouseUp",
    )?.[1] as (() => void) | undefined;
    expect(mouseDown).toBeDefined();
    expect(mouseUp).toBeDefined();

    mouseDown?.();
    mouseUp?.();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(from);
  });

  it("dispose removes listeners via controls.dispose", () => {
    const fakeControls = {
      addEventListener: vi.fn(),
      dispose: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
      getHelper: () => ({}),
    };
    const adapter = createTransformControlsAdapter({
      controls: fakeControls as never,
      onStart: () => ({
        position: [0, 0, 0] as const,
        rotation: [0, 0, 0] as const,
        scale: [1, 1, 1] as const,
      }),
      onCommit: () => {},
    });
    adapter.dispose();
    expect(fakeControls.dispose).toHaveBeenCalledTimes(1);
  });
});
