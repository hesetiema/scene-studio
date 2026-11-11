// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import type { RuntimeFactoryOptions } from "../../src/element/scene-editor-element";
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
  factoryOptions: () => RuntimeFactoryOptions | undefined;
}

function makeElement(): Harness {
  const fake = new FakeRuntime();
  let captured: AssetResolver | undefined;
  let capturedOptions: RuntimeFactoryOptions | undefined;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options?.assetResolver;
    capturedOptions = options;
    return fake;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return {
    el,
    fake,
    resolver: () => captured,
    factoryOptions: () => capturedOptions,
  };
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

  it("keeps a host-provided resolver for host ids", async () => {
    const { el, resolver } = makeElement();
    const hostResolver: AssetResolver = { resolve: async (id) => `/assets/${id}.glb` };
    el.assetResolver = hostResolver;
    el.setAttribute("src", "ignored.glb");
    await connected(el);

    // The element wraps the host table (it has to reserve its own ids), but
    // every id the host owns still goes to the host.
    await expect(resolver()!.resolve("robot")).resolves.toBe("/assets/robot.glb");
    await expect(resolver()!.resolve(SRC_ASSET_ID)).resolves.toBe("ignored.glb");
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

describe("decoder injection", () => {
  it("forwards the assigned decoders to the runtime factory", async () => {
    const { el, factoryOptions } = makeElement();
    const draco = { kind: "draco" };
    const ktx2 = { kind: "ktx2" };
    const meshopt = { kind: "meshopt" };

    // Assigned the way a host does it: properties, before `src` is set.
    el.dracoLoader = draco;
    el.ktx2Loader = ktx2;
    el.meshoptDecoder = meshopt;
    await connected(el);

    // The factory gets a getter, not a snapshot: the loader layer reads it
    // before each load, so an assignment after connect still applies.
    expect(factoryOptions()?.getDecoders?.()).toEqual({
      dracoLoader: draco,
      ktx2Loader: ktx2,
      meshoptDecoder: meshopt,
    });
  });

  it("reads the getter lazily, so a decoder set after connect is seen", async () => {
    const { el, factoryOptions } = makeElement();
    await connected(el);
    const getDecoders = factoryOptions()?.getDecoders;
    expect(getDecoders?.().dracoLoader).toBeNull();

    const draco = { kind: "draco" };
    el.dracoLoader = draco;
    expect(getDecoders?.().dracoLoader).toBe(draco);
  });

  it("treats clearing a decoder as null rather than undefined", async () => {
    const { el, factoryOptions } = makeElement();
    await connected(el);
    el.ktx2Loader = { kind: "ktx2" };
    el.ktx2Loader = null;
    expect(factoryOptions()?.getDecoders?.().ktx2Loader).toBeNull();
  });
});

describe("material variants (`variant-name`)", () => {
  /** FakeRuntime has no variant support; bolt the two members onto it. */
  function withVariants(fake: FakeRuntime, variants: string[] = []) {
    const setVariant = vi.fn(() => true);
    const target = fake as unknown as Record<string, unknown>;
    target.setVariant = setVariant;
    target.variants = variants;
    return setVariant;
  }

  it("applies variant-name to the runtime", async () => {
    const { el, fake } = makeElement();
    const setVariant = withVariants(fake);
    el.setAttribute("variant-name", "Red");
    await connected(el);

    expect(setVariant).toHaveBeenCalledWith("Red");
  });

  it("treats an empty or missing attribute as the asset default", async () => {
    const { el, fake } = makeElement();
    const setVariant = withVariants(fake);
    el.setAttribute("variant-name", "");
    await connected(el);

    expect(setVariant).toHaveBeenLastCalledWith(null);

    el.setAttribute("variant-name", "Blue");
    expect(setVariant).toHaveBeenLastCalledWith("Blue");

    el.removeAttribute("variant-name");
    expect(setVariant).toHaveBeenLastCalledWith(null);
  });

  it("re-asserts the variant after a load, when the asset finally declares it", async () => {
    const { el, fake } = makeElement();
    const setVariant = withVariants(fake);
    el.setAttribute("variant-name", "Red");
    await connected(el);
    setVariant.mockClear();

    // A name set before the asset parsed has to be applied retroactively: the
    // runtime only learns the variant list once the glTF is in.
    el.setAttribute("src", "a.glb");
    await nextTick();

    expect(setVariant).toHaveBeenCalledWith("Red");
  });

  it("exposes availableVariants and mirrors variantName to the attribute", async () => {
    const { el, fake } = makeElement();
    withVariants(fake, ["Red", "Blue"]);
    await connected(el);

    expect(el.availableVariants).toEqual(["Red", "Blue"]);
    expect(el.variantName).toBeNull();

    el.variantName = "Blue";
    expect(el.getAttribute("variant-name")).toBe("Blue");

    el.variantName = null;
    expect(el.hasAttribute("variant-name")).toBe(false);
  });

  it("stays inert on a runtime without variant support", async () => {
    const { el } = makeElement();
    await connected(el);
    // No `setVariant` on the fake: the attribute must not throw.
    expect(() => el.setAttribute("variant-name", "Red")).not.toThrow();
    expect(el.availableVariants).toEqual([]);
  });
});

describe("embedded cameras and morph targets", () => {
  it("mirrors camera-name to the attribute and back", async () => {
    const { el, fake } = makeElement();
    fake.camerasList = ["Detail"];
    await connected(el);

    expect(el.cameras).toEqual(["Detail"]);
    expect(el.cameraName).toBeNull();

    el.setAttribute("camera-name", "Detail");
    expect(fake.calls.setCameraByName.at(-1)).toBe("Detail");
    expect(fake.cameraName).toBe("Detail");

    el.cameraName = null;
    expect(el.hasAttribute("camera-name")).toBe(false);
    expect(fake.cameraName).toBeNull();
  });

  it("re-asserts the camera after a load, when the asset finally declares it", async () => {
    const { el, fake } = makeElement();
    fake.camerasList = ["Detail"];
    el.setAttribute("camera-name", "Detail");
    await connected(el);
    fake.calls.setCameraByName.length = 0;

    el.setAttribute("src", "a.glb");
    await nextTick();

    expect(fake.calls.setCameraByName.at(-1)).toBe("Detail");
  });

  it("exposes morph channels and refuses the animated ones", async () => {
    const { el, fake } = makeElement();
    fake.morphList = [
      {
        objectId: "box-1",
        meshIndex: 0,
        meshName: "Face",
        targetIndex: 0,
        name: "Smile",
        influence: 0,
        driven: false,
      },
    ];
    await connected(el);

    expect(el.morphTargets.map((entry) => entry.name)).toEqual(["Smile"]);
    expect(el.setMorphInfluence("box-1", 0, 0, 0.5)).toBe(true);
    expect(el.morphTargets[0]?.influence).toBeCloseTo(0.5);

    fake.morphList[0]!.driven = true;
    expect(el.setMorphInfluence("box-1", 0, 0, 0.9)).toBe(false);
  });
});

describe("preview display settings", () => {
  it("defaults src previews to neutral, which is what model-viewer's auto resolves to", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);
    expect(fake.calls.setToneMapping).toEqual(["neutral"]);
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
    expect(fake.calls.setToneMapping).toEqual(["neutral", "none"]);
  });

  it("frameModel() delegates to the runtime", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    el.frameModel();
    expect(fake.calls.autoFrame).toBe(1);
  });

  it("maps shadow-intensity to a display-only contact shadow", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("shadow-intensity", "0.5");
    el.setAttribute("shadow-softness", "0.25");
    await connected(el);

    const last = fake.calls.applyViewState.at(-1);
    // Intensity goes through unchanged: the rig applies model-viewer's own
    // softness easing on top, so a fudge factor here would double-darken it.
    expect(last?.environment.contactShadow).toEqual({
      enabled: true,
      opacity: 0.5,
      softness: 0.25,
    });
  });

  it("treats shadow-intensity=0 as no shadow at all", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("shadow-intensity", "0");
    await connected(el);

    expect(fake.calls.applyViewState.at(-1)?.environment.contactShadow).toBeUndefined();
  });

  it("re-asserts the contact shadow after a load overwrites the view", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    el.setAttribute("shadow-intensity", "1");
    await connected(el);
    await nextTick();

    // The fake replaces the view on load, the way a document's `view` does.
    fake.calls.applyViewState.length = 0;
    fake.applyViewState({ ...fake.getViewState() });
    el.setAttribute("shadow-softness", "0.8");
    expect(fake.calls.applyViewState.at(-1)?.environment.contactShadow).toEqual({
      enabled: true,
      opacity: 1,
      softness: 0.8,
    });
  });
});
