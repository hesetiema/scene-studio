// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createPicker, type RaycastHit } from "../../src/three/picker";
import { createTransformControlsBinding } from "../../src/three/transform-controls-binding";

describe("createPicker (click → objectId)", () => {
  it("maps normalized coordinates through raycaster and returns top hit id or null", () => {
    const raycast = vi.fn((): RaycastHit[] => [
      { object: { userData: { sceneObjectId: "obj-b" }, parent: null } as never, distance: 2 },
      { object: { userData: { sceneObjectId: "obj-a" }, parent: null } as never, distance: 1 },
    ]);
    const camera = { isCamera: true } as never;
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as never;
    const picker = createPicker({
      raycast,
      camera,
      canvas,
    });
    const hit = picker.pick({ clientX: 400, clientY: 300 });
    expect(raycast).toHaveBeenCalledWith(0, 0); // center of 800x600
    expect(hit).toBe("obj-a"); // nearest distance wins
  });

  it("returns null when nothing is hit", () => {
    const picker = createPicker({
      raycast: () => [],
      camera: { isCamera: true } as never,
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      } as never,
    });
    expect(picker.pick({ clientX: 0, clientY: 0 })).toBeNull();
  });

  it("skips hits without sceneObjectId userData", () => {
    const picker = createPicker({
      raycast: () => [{ object: { userData: {}, parent: null } as never, distance: 1 }],
      camera: { isCamera: true } as never,
      canvas: {
        clientWidth: 100,
        clientHeight: 100,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      } as never,
    });
    expect(picker.pick({ clientX: 50, clientY: 50 })).toBeNull();
  });
});

describe("createTransformControlsBinding (one drag = one command, D15)", () => {
  type Listener = (e: { object?: unknown }) => void;

  function makeControls() {
    const listeners = new Map<string, Listener>();
    const detach = vi.fn();
    const attach = vi.fn();
    const removeEventListener = vi.fn((type: string) => {
      listeners.delete(type);
    });
    return {
      listeners,
      detach,
      attach,
      removeEventListener,
      addEventListener(type: string, fn: Listener) {
        listeners.set(type, fn);
      },
    };
  }

  function obj3d(x = 0, y = 0, z = 0) {
    return {
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }

  it("emits one Transform on mouseUp with from@mouseDown and to@mouseUp", () => {
    const controls = makeControls();
    const transforms: unknown[] = [];
    const binding = createTransformControlsBinding({
      controls,
      getSelectedObject: () => obj3d(0, 0, 0) as never,
      onTransform: (t) => transforms.push(t),
    });
    // mouseDown captures from
    controls.listeners.get("mouseDown")!({ object: obj3d(0, 0, 0) });
    // simulate mid-drag position on the selected object
    binding.updateSelectedObject(obj3d(2, 0, 0) as never);
    controls.listeners.get("mouseUp")!({ object: obj3d(2, 0, 0) });
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({
      from: { position: [0, 0, 0] },
      to: { position: [2, 0, 0] },
    });
    binding.dispose();
  });

  it("ignores mouseUp without a preceding mouseDown (no orphan commands)", () => {
    const controls = makeControls();
    const transforms: unknown[] = [];
    const binding = createTransformControlsBinding({
      controls,
      getSelectedObject: () => obj3d() as never,
      onTransform: (t) => transforms.push(t),
    });
    controls.listeners.get("mouseUp")!({ object: obj3d(1, 0, 0) });
    expect(transforms).toHaveLength(0);
    binding.dispose();
  });

  it("dispose detaches and removes listeners", () => {
    const controls = makeControls();
    const binding = createTransformControlsBinding({
      controls,
      getSelectedObject: () => obj3d() as never,
      onTransform: () => {},
    });
    binding.dispose();
    expect(controls.detach).not.toHaveBeenCalled(); // dispose only unhooks, detach is explicit
    expect(controls.listeners.size).toBe(0);
    expect(controls.removeEventListener).toHaveBeenCalled();
  });
});
