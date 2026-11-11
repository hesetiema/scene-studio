// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { AssetCache } from "../../src/assets/asset-cache";
import type { RendererHandle } from "../../src/three/renderer-handle";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

function stubRenderer(): RendererHandle {
  return { render() {}, setSize() {}, setPixelRatio() {}, dispose() {} };
}

describe("ThreeRuntime animation surface", () => {
  it("reports clips mounted with an asset and plays them", async () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    const clip = new THREE.AnimationClip("Slide", 1, [
      new THREE.VectorKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: stubRenderer,
      enableControls: false,
      assetCache: new AssetCache(async () => ({ scene: group, animations: [clip] })),
    });

    await runtime.loadDocument({
      schemaVersion: SCHEMA_VERSION,
      view: createDefaultViewState(),
      sceneId: "s-anim",
      revision: 0,
      objects: [
        {
          id: "animated",
          type: "mesh",
          name: "Animated",
          assetId: "rigged",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    });

    expect(runtime.animations).toEqual([
      { id: "animated#0", objectId: "animated", index: 0, name: "Slide", duration: 1 },
    ]);
    expect(runtime.playAnimation("animated")).toBe(true);
    expect(runtime.animationPlaying).toBe(true);
    runtime.pauseAnimations();
    expect(runtime.animationPlaying).toBe(false);

    runtime.flushDisposers();
  });

  it("clears clips when the document is replaced", async () => {
    const clip = new THREE.AnimationClip("Slide", 1, []);
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: stubRenderer,
      enableControls: false,
      assetCache: new AssetCache(async () => ({
        scene: new THREE.Group(),
        animations: [clip],
      })),
    });

    const doc: SceneDocument = {
      schemaVersion: SCHEMA_VERSION,
      view: createDefaultViewState(),
      sceneId: "s-anim",
      revision: 0,
      objects: [
        {
          id: "animated",
          type: "mesh",
          name: "Animated",
          assetId: "rigged",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    };

    await runtime.loadDocument(doc);
    expect(runtime.animations).toHaveLength(1);
    await runtime.loadDocument({ ...doc, objects: [] });
    expect(runtime.animations).toEqual([]);
  });

  it("blends two clips of one object and reports the layers", async () => {
    const group = new THREE.Group();
    const walk = new THREE.AnimationClip("Walk", 1, [
      new THREE.VectorKeyframeTrack(".position[x]", [0, 1], [0, 10]),
    ]);
    const wave = new THREE.AnimationClip("Wave", 1, [
      new THREE.VectorKeyframeTrack(".position[y]", [0, 1], [0, 10]),
    ]);
    const runtime = new ThreeRuntime({
      canvas: document.createElement("canvas"),
      rendererFactory: stubRenderer,
      enableControls: false,
      assetCache: new AssetCache(async () => ({ scene: group, animations: [walk, wave] })),
    });

    await runtime.loadDocument({
      schemaVersion: SCHEMA_VERSION,
      view: createDefaultViewState(),
      sceneId: "s-blend",
      revision: 0,
      objects: [
        {
          id: "animated",
          type: "mesh",
          name: "Animated",
          assetId: "rigged",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    });

    expect(runtime.playAnimationBlend([{ index: 0, weight: 1 }, { index: 1, weight: 1 }], "animated")).toBe(
      true,
    );
    expect(runtime.animationPlaying).toBe(true);
    expect(runtime.animationBlend).toEqual([
      { index: 0, weight: 0.5, timeScale: 1 },
      { index: 1, weight: 0.5, timeScale: 1 },
    ]);

    runtime.pauseAnimations();
    expect(runtime.animationPlaying).toBe(false);
    runtime.flushDisposers();
  });
});
