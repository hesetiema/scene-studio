import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { sceneDocument, sceneObject } from "../support/documents";

function stubRenderer(): RendererHandle & { renders: number } {
  return {
    renders: 0,
    toneMapping: 0,
    toneMappingExposure: 1,
    render() {
      this.renders += 1;
    },
    setSize() {},
    setPixelRatio() {},
    dispose() {},
  };
}

function makeRuntime(
  renderer: RendererHandle = stubRenderer(),
  extra: Record<string, unknown> = {},
) {
  const runtime = new ThreeRuntime({
    canvas: {} as HTMLCanvasElement,
    rendererFactory: () => renderer,
    enableControls: false,
    ...extra,
  } as never);
  return { runtime, renderer };
}

describe("ThreeRuntime stage A: autoFrame", () => {
  it("centers on the content bounds and backs off to fit", async () => {
    const { runtime } = makeRuntime();
    await runtime.loadDocument(
      sceneDocument({
        objects: [sceneObject({ id: "box", position: [2, 0.5, 0] })],
      }),
    );

    const before = runtime.camera.position.clone();
    runtime.autoFrame();
    const view = runtime.getViewState();

    expect(view.camera.target[0]).toBeCloseTo(2, 5);
    expect(view.camera.target[1]).toBeCloseTo(0.5, 5);
    expect(view.camera.target[2]).toBeCloseTo(0, 5);
    expect(runtime.camera.position.distanceTo(before)).toBeGreaterThan(0);
    expect(runtime.camera.position.distanceTo(new THREE.Vector3(2, 0.5, 0))).toBeGreaterThan(1);
  });

  it("keeps the target reachable for a larger, off-center model", async () => {
    const { runtime } = makeRuntime();
    await runtime.loadDocument(
      sceneDocument({
        objects: [sceneObject({ id: "box", position: [-8, 4, 6], scale: [6, 6, 6] })],
      }),
    );

    runtime.autoFrame();
    const view = runtime.getViewState();
    expect(view.camera.target).toEqual([-8, 4, 6]);
    expect(runtime.camera.near).toBeGreaterThan(0);
    expect(runtime.camera.far).toBeGreaterThan(runtime.camera.near);
  });

  it("is a no-op on an empty document", () => {
    const { runtime } = makeRuntime();
    const before = runtime.camera.position.clone();
    runtime.autoFrame();
    expect(runtime.camera.position.equals(before)).toBe(true);
  });
});

describe("ThreeRuntime stage A: display settings", () => {
  it("maps tone mapping names to three constants", () => {
    const { runtime, renderer } = makeRuntime();

    runtime.setToneMapping("aces");
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);

    runtime.setToneMapping("agx");
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);

    runtime.setToneMapping("none");
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
  });

  it("ignores unknown modes instead of blanking the output", () => {
    const { runtime, renderer } = makeRuntime();
    runtime.setToneMapping("aces");
    runtime.setToneMapping("bogus" as never);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
  });

  it("applies exposure and clamps negatives", () => {
    const { runtime, renderer } = makeRuntime();
    runtime.setExposure(1.75);
    expect(renderer.toneMappingExposure).toBe(1.75);

    runtime.setExposure(-2);
    expect(renderer.toneMappingExposure).toBe(0);

    runtime.setExposure(Number.NaN);
    expect(renderer.toneMappingExposure).toBe(0);
  });

  it("accepts constructor options", () => {
    const renderer = stubRenderer();
    makeRuntime(renderer, { toneMapping: "neutral", exposure: 1.2 });

    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.2);
  });

  it("does not clobber a pre-configured renderer when only exposure changes", () => {
    const renderer = stubRenderer();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const { runtime } = makeRuntime(renderer);

    runtime.setExposure(1.5);

    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.5);
  });

  it("degrades quietly on stubs without display settings", () => {
    const bare: RendererHandle = {
      render() {},
      setSize() {},
      setPixelRatio() {},
      dispose() {},
    };
    const { runtime } = makeRuntime(bare);
    expect(() => runtime.setToneMapping("aces")).not.toThrow();
    expect(() => runtime.setExposure(2)).not.toThrow();
  });
});

describe("ThreeRuntime stage A: load lifecycle", () => {
  it("reports a monotonic progress ramp and a load edge", async () => {
    const { runtime } = makeRuntime();
    const progress: number[] = [];
    const loads: string[] = [];
    runtime.events.on("load-progress", ({ totalProgress }) => progress.push(totalProgress));
    runtime.events.on("load", ({ sceneId }) => loads.push(sceneId));

    await runtime.loadDocument(
      sceneDocument({ sceneId: "scene-9", objects: [sceneObject({ id: "box" })] }),
    );

    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
    expect(loads).toEqual(["scene-9"]);
  });

  it("still emits load for a document without meshes", async () => {
    const { runtime } = makeRuntime();
    const progress: number[] = [];
    runtime.events.on("load-progress", ({ totalProgress }) => progress.push(totalProgress));

    await runtime.loadDocument(sceneDocument({ sceneId: "empty" }));

    expect(progress).toEqual([1]);
  });
});
