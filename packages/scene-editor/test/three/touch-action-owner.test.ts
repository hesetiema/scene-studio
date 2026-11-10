// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createTouchActionOwner } from "../../src/three/viewer/touch-action-owner";

/** MutationObserver delivery is a microtask; one macrotask turn is plenty. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTouchActionOwner", () => {
  it("writes the requested value straight away", () => {
    const canvas = document.createElement("canvas");

    createTouchActionOwner(canvas).set("pan-y");

    expect(canvas.style.touchAction).toBe("pan-y");
  });

  it("does nothing until something is requested", () => {
    const canvas = document.createElement("canvas");
    canvas.style.touchAction = "none";

    const owner = createTouchActionOwner(canvas);
    owner.set("pan-y");
    owner.set(null);

    expect(canvas.style.touchAction).toBe("pan-y");
  });

  it("takes the canvas back when another addon claims it later", async () => {
    const canvas = document.createElement("canvas");
    const owner = createTouchActionOwner(canvas);
    owner.set("pan-y");

    // TransformControls does exactly this on connect — after our mount, and
    // from a different dynamic import, which is the race this guards.
    canvas.style.touchAction = "none";
    await flush();

    expect(canvas.style.touchAction).toBe("pan-y");
  });

  it("stops holding the canvas once released", async () => {
    const canvas = document.createElement("canvas");
    const owner = createTouchActionOwner(canvas);
    owner.set("pan-y");
    owner.set(null);

    canvas.style.touchAction = "none";
    await flush();

    expect(canvas.style.touchAction).toBe("none");
  });

  it("stops holding the canvas after dispose", async () => {
    const canvas = document.createElement("canvas");
    const owner = createTouchActionOwner(canvas);
    owner.set("pan-y");
    owner.dispose();

    canvas.style.touchAction = "none";
    await flush();

    expect(canvas.style.touchAction).toBe("none");
  });

  it("accepts a style-only stub (no observer available)", () => {
    const style = { touchAction: "" } as CSSStyleDeclaration;
    const owner = createTouchActionOwner({ style });

    owner.set("pan-x");
    expect(style.touchAction).toBe("pan-x");

    // Nothing to observe, so this must stay quiet rather than throw.
    owner.dispose();
    expect(style.touchAction).toBe("pan-x");
  });

  it("survives a missing element", () => {
    const owner = createTouchActionOwner(undefined);
    expect(() => {
      owner.set("pan-y");
      owner.dispose();
    }).not.toThrow();
  });
});
