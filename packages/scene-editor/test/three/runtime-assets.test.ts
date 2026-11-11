// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { AssetCache } from "../../src/assets/asset-cache";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";
import type { LoadedAsset } from "../../src/assets/asset-cache";

function stubRenderer(): RendererHandle & { disposed: boolean; renders: number } {
  return {
    disposed: false,
    renders: 0,
    render() {
      this.renders += 1;
    },
    setSize() {},
    setPixelRatio() {},
    dispose() {
      this.disposed = true;
    },
  };
}

function makeAsset(assetId: string): LoadedAsset {
  const dispose = vi.fn();
  const root = new THREE.Group();
  root.name = assetId;
  return { scene: root, dispose };
}

function makeDoc(objects: SceneDocument["objects"]): SceneDocument {
  return { schemaVersion: SCHEMA_VERSION, sceneId: "s", revision: 0, objects, view: createDefaultViewState() };
}

function assetObj(id: string, assetId: string) {
  return {
    id,
    type: "mesh" as const,
    name: id,
    assetId,
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function boxObj(id: string) {
  return {
    id,
    type: "mesh" as const,
    name: id,
    position: [1, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function makeRuntime(cache?: AssetCache) {
  const renderer = stubRenderer();
  const runtime = new ThreeRuntime({
    canvas: document.createElement("canvas"),
    rendererFactory: () => renderer,
    enableControls: false,
    ...(cache ? { assetCache: cache } : {}),
  });
  return { runtime, renderer };
}

describe("ThreeRuntime asset loading (D11/D12/D16)", () => {
  it("loads assetId objects via cache, clones per reference", async () => {
    const loads: string[] = [];
    const cache = new AssetCache(async (id) => {
      loads.push(id);
      return makeAsset(id);
    });
    const { runtime } = makeRuntime(cache);
    await runtime.loadDocument(
      makeDoc([assetObj("a1", "hero"), assetObj("a2", "hero"), boxObj("b")]),
    );
    expect(loads).toEqual(["hero"]); // one network load for two refs
    expect(cache.refCount("hero")).toBe(2);
    expect(runtime.getObjectById("a1")).toBeDefined();
    expect(runtime.getObjectById("a2")).toBeDefined();
    expect(runtime.getObjectById("b")).toBeDefined(); // placeholder box
    // distinct clones
    expect(runtime.getObjectById("a1")).not.toBe(runtime.getObjectById("a2"));
  });

  it("document-swap releases old refs then retains new (no double-count)", async () => {
    const cache = new AssetCache(async (id) => makeAsset(id));
    const { runtime } = makeRuntime(cache);
    await runtime.loadDocument(makeDoc([assetObj("a", "old")]));
    expect(cache.refCount("old")).toBe(1);
    await runtime.loadDocument(makeDoc([assetObj("a", "new")]));
    expect(cache.refCount("old")).toBe(0);
    expect(cache.refCount("new")).toBe(1);
  });

  it("flushDisposers releases all asset refs", async () => {
    const cache = new AssetCache(async (id) => makeAsset(id));
    const { runtime } = makeRuntime(cache);
    await runtime.loadDocument(makeDoc([assetObj("a", "hero"), assetObj("b", "hero")]));
    expect(cache.refCount("hero")).toBe(2);
    runtime.flushDisposers();
    expect(cache.refCount("hero")).toBe(0);
  });

  it("partial failure: emits error event, still loads healthy objects", async () => {
    const cache = new AssetCache(async (id) => {
      if (id === "broken") throw new Error("404");
      return makeAsset(id);
    });
    const { runtime } = makeRuntime(cache);
    const errors: Array<{ code: string; message: string }> = [];
    runtime.events.on("error", (e) => errors.push(e));
    await runtime.loadDocument(
      makeDoc([assetObj("bad", "broken"), assetObj("ok", "fine"), boxObj("plain")]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("asset-load-failed");
    expect(runtime.getObjectById("bad")).toBeUndefined(); // failed object not placed
    expect(runtime.getObjectById("ok")).toBeDefined();
    expect(runtime.getObjectById("plain")).toBeDefined();
  });

  it("forwards the loader's AssetErrorCode instead of collapsing it", async () => {
    const cache = new AssetCache(async (id) => {
      throw new AssetError(AssetErrorCode.UnsupportedFormat, `Unsupported asset: ${id}`, {
        detail: { assetId: id },
      });
    });
    const { runtime } = makeRuntime(cache);
    const errors: Array<{ code: string; message: string }> = [];
    runtime.events.on("error", (e) => errors.push(e));
    await runtime.loadDocument(makeDoc([assetObj("bad", "legacy")]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("asset-unsupported-format");
  });

  it("assetId without a cache reports an error instead of a silent placeholder", async () => {
    // This used to mount the 1x1x1 placeholder and still report `load`: a
    // document naming an asset was indistinguishable from an empty viewport.
    const { runtime } = makeRuntime(); // no cache
    const errors: Array<{ code: string; message: string }> = [];
    runtime.events.on("error", (e) => errors.push(e));

    await runtime.loadDocument(makeDoc([assetObj("a", "hero")]));

    expect(runtime.getObjectById("a")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("asset-not-found");
    expect(errors[0]!.message).toContain("hero");
  });
});
