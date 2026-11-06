// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { createSrcDocument, SRC_ASSET_ID, SRC_SCENE_ID } from "../../src/element/src-document";
import { PREVIEW_FOV } from "../../src/core/document/default-view";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { AssetResolver } from "../../src/assets/resolver-asset-loader";
import { sceneDocument } from "../support/documents";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  el: SceneEditorElement;
  fake: FakeRuntime;
  resolver: () => AssetResolver | undefined;
}

function makeElement(): Harness {
  const fake = new FakeRuntime();
  let captured: AssetResolver | undefined;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options?.assetResolver;
    return fake;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake, resolver: () => captured };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

describe("createSrcDocument", () => {
  it("synthesizes a single mesh document pointing at the reserved asset", () => {
    const doc = createSrcDocument("https://cdn.test/models/robot.glb?v=2");
    expect(doc.sceneId).toBe(SRC_SCENE_ID);
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]).toMatchObject({
      id: SRC_ASSET_ID,
      assetId: SRC_ASSET_ID,
      type: "mesh",
      name: "robot.glb",
    });
  });

  it("falls back to a stable name for pathological URLs", () => {
    expect(createSrcDocument("https://cdn.test/").objects[0]?.name).toBe("model");
    expect(createSrcDocument("model.glb").objects[0]?.name).toBe("model.glb");
  });

  it("uses viewer defaults, not editor defaults (model-viewer parity)", () => {
    const view = createSrcDocument("fox.glb").view;

    // 45° = model-viewer's `field-of-view="auto"`.
    expect(view.camera.fov).toBe(PREVIEW_FOV);
    // The floor grid is authoring chrome; a viewer has none.
    expect(view.environment.gridVisible).toBe(false);
    // Lighting comes from the environment map alone (no second, flatter key light).
    expect(view.lights.ambient.intensity).toBe(0);
    expect(view.lights.directional.intensity).toBe(0);
    expect(view.environment.iblIntensity).toBe(1);
  });
});

describe("<scene-editor src> preview entry", () => {
  it("loads the synthesized document and frames it", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "https://cdn.test/models/robot.glb");
    await connected(el);
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(1);
    expect(fake.calls.loadDocument[0]?.objects[0]?.assetId).toBe(SRC_ASSET_ID);
    expect(fake.calls.autoFrame).toBe(1);
  });

  it("previews with the neutral studio and switches back for host documents", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "https://cdn.test/models/robot.glb");
    await connected(el);
    await nextTick();

    expect(fake.calls.setEnvironmentPreset.at(-1)).toBe("neutral");

    await el.loadDocument(sceneDocument({ sceneId: "host-scene" }));
    expect(fake.calls.setEnvironmentPreset.at(-1)).toBe("room");
  });

  it("environment-image overrides the mode default", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "https://cdn.test/models/robot.glb");
    el.setAttribute("environment-image", "room");
    await connected(el);
    await nextTick();
    expect(fake.calls.setEnvironmentPreset.at(-1)).toBe("room");

    el.setAttribute("environment-image", "neutral");
    expect(fake.calls.setEnvironmentPreset.at(-1)).toBe("neutral");
  });

  it("resolves only the reserved asset id to the src URL", async () => {
    const { el, resolver } = makeElement();
    el.setAttribute("src", "https://cdn.test/robot.glb");
    await connected(el);

    const assetResolver = resolver();
    expect(assetResolver).toBeDefined();
    await expect(assetResolver!.resolve(SRC_ASSET_ID)).resolves.toBe(
      "https://cdn.test/robot.glb",
    );
    await expect(assetResolver!.resolve("something-else")).rejects.toThrow(/Unknown asset/);
  });

  it("keeps a host-provided resolver", async () => {
    const { el, resolver } = makeElement();
    const hostResolver: AssetResolver = { resolve: async (id) => `/assets/${id}.glb` };
    el.assetResolver = hostResolver;
    el.setAttribute("src", "ignored.glb");
    await connected(el);

    expect(resolver()).toBe(hostResolver);
  });

  it("reloads when src changes and the element owns the document", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);
    await nextTick();

    el.setAttribute("src", "b.glb");
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(2);
    expect(fake.calls.loadDocument[1]?.objects[0]?.name).toBe("b.glb");
  });

  it("keeps the host document until src changes again", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);
    await nextTick();

    await el.loadDocument(sceneDocument({ sceneId: "host-scene" }));
    // A host document is not clobbered by unrelated attribute churn.
    el.setAttribute("tone-mapping", "neutral");
    await nextTick();
    expect(el.getDocument().sceneId).toBe("host-scene");

    // Changing src is an explicit switch back to preview.
    el.setAttribute("src", "b.glb");
    await nextTick();
    expect(fake.calls.loadDocument).toHaveLength(3);
    expect(el.getDocument().objects[0]?.assetId).toBe(SRC_ASSET_ID);
  });

  it("stays inert without src", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(0);
    expect(fake.calls.autoFrame).toBe(0);
  });

  it("bridges progress and load, adding the resolved URL", async () => {
    const { el } = makeElement();
    const progressSpy = vi.fn();
    const loadSpy = vi.fn();
    el.addEventListener("progress", progressSpy);
    el.addEventListener("load", loadSpy);
    el.setAttribute("src", "https://cdn.test/robot.glb");
    await connected(el);
    await nextTick();

    expect(progressSpy).toHaveBeenCalled();
    expect(progressSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      detail: { totalProgress: 1, reason: "model-load" },
    });
    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { sceneId: SRC_SCENE_ID, url: "https://cdn.test/robot.glb" },
      }),
    );
  });

  it("reports url: null for host-loaded documents", async () => {
    const { el } = makeElement();
    const loadSpy = vi.fn();
    el.addEventListener("load", loadSpy);
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { sceneId: "s-1", url: null } }),
    );
  });
});

describe("preview display settings", () => {
  it("defaults src previews to ACES", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);
    expect(fake.calls.setToneMapping).toEqual(["aces"]);
  });

  it("leaves documents on the engine default", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    expect(fake.calls.setToneMapping).toEqual([]);
  });

  it("honors an explicit tone-mapping / exposure", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("tone-mapping", "neutral");
    el.setAttribute("exposure", "1.4");
    el.setAttribute("src", "a.glb");
    await connected(el);

    expect(fake.calls.setToneMapping).toEqual(["neutral"]);
    expect(fake.calls.setExposure).toEqual([1.4]);
  });

  it("toggles tone mapping at runtime", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);

    el.setAttribute("tone-mapping", "none");
    expect(fake.calls.setToneMapping).toEqual(["aces", "none"]);
  });

  it("frameModel() delegates to the runtime", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    el.frameModel();
    expect(fake.calls.autoFrame).toBe(1);
  });
});
