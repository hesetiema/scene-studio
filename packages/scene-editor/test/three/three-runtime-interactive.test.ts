// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
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

/** Minimal TransformControls double: the rig only needs attach/detach/helper. */
function fakeControls() {
  const helper = new THREE.Object3D();
  const controls = {
    helper,
    attached: null as THREE.Object3D | null,
    disposed: false,
    setMode: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    attach(object: THREE.Object3D): void {
      controls.attached = object;
    },
    detach(): void {
      controls.attached = null;
    },
    getHelper: () => helper,
    dispose: () => {
      controls.disposed = true;
    },
  };
  return controls;
}

function makeRuntime(extra: Record<string, unknown> = {}) {
  const controls = fakeControls();
  const factory = vi.fn(() => controls);
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: stubRenderer as never,
    enableControls: true,
    orbitControlsFactory: () => null,
    transformControlsFactory: factory,
    ...extra,
  } as never);
  return { runtime, controls, factory };
}

function docWith(scale: number): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "s",
    revision: 0,
    objects: [
      {
        id: "obj",
        type: "mesh",
        name: "obj",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [scale, scale, scale],
      },
    ],
    view: createDefaultViewState(),
  };
}

describe("ThreeRuntime interactive (viewer vs editor chrome)", () => {
  it("does not create a gizmo when interactive is false", async () => {
    const { runtime, factory } = makeRuntime({ interactive: false });

    await expect(runtime.controlsReady).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.interactive).toBe(false);
  });

  it("mounts the gizmo by default (editor behaviour)", async () => {
    const { runtime, factory, controls } = makeRuntime();
    await runtime.controlsReady;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.scene.getObjectById(controls.helper.id)).toBeDefined();
    runtime.flushDisposers();
  });

  it("mounts on demand and tears down again", async () => {
    const { runtime, factory, controls } = makeRuntime({ interactive: false });
    await runtime.loadDocument(docWith(1));

    runtime.setInteractive(true);
    await runtime.controlsReady;
    expect(factory).toHaveBeenCalledTimes(1);

    runtime.select(["obj"]);
    expect(controls.attached).not.toBeNull();

    runtime.setInteractive(false);
    expect(controls.disposed).toBe(true);
    // The helper leaves the scene and the selection is dropped: a viewer has
    // neither axes nor a selected object.
    expect(runtime.scene.getObjectById(controls.helper.id)).toBeUndefined();
    expect(runtime.selectedIds).toEqual([]);
  });

  it("keeps programmatic selection working without chrome", async () => {
    const { runtime, factory } = makeRuntime({ interactive: false });
    await runtime.loadDocument(docWith(1));

    runtime.select(["obj"]);
    expect(runtime.selectedIds).toEqual(["obj"]);
    // No mount, no attach: the selection is data, not a gizmo.
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("ThreeRuntime clip planes follow the content scale", () => {
  async function framed(scale: number) {
    const { runtime } = makeRuntime({ interactive: false });
    await runtime.loadDocument(docWith(scale));
    runtime.autoFrame();
    return runtime;
  }

  it("scales near/far with the model instead of pinning 0.1/1000", async () => {
    const unit = await framed(1);
    const huge = await framed(1_000_000);

    // A unit cube sits inside the old fixed pair; the million-times model is
    // exactly the case the old `far = 1000` clipped away.
    expect(unit.camera.far).toBeGreaterThan(1);
    expect(huge.camera.far / unit.camera.far).toBeGreaterThan(1e5);
    expect(huge.camera.near / unit.camera.near).toBeGreaterThan(1e5);
    expect(huge.camera.far).toBeGreaterThan(1e6);
  });

  it("follows a dolly without a re-frame", async () => {
    const { runtime } = makeRuntime({ interactive: false });
    await runtime.loadDocument(docWith(1));
    runtime.autoFrame();

    const farBefore = runtime.camera.far;
    // Simulate a zoom-in: OrbitControls only moves the camera and calls render.
    runtime.camera.position.multiplyScalar(0.01);
    runtime.render();

    expect(runtime.camera.far).toBeLessThan(farBefore);
    expect(runtime.camera.near).toBeGreaterThan(0);
  });
});
