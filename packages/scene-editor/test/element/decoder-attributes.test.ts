// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import type { RuntimeFactoryOptions } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import {
  DEFAULT_DECODER_CDN,
  type LazyDecoderBundle,
  type LazyDecoderOptions,
} from "../../src/assets/lazy-decoders";
import type { GltfDecoders } from "../../src/assets/gltf-asset-loader";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;
const ORIGINAL_DECODER_FACTORY = SceneEditorElement.decoderBundleFactory;

interface BundleState {
  path: string;
  readyCalls: number;
  disposed: number;
  decoders: GltfDecoders;
  /** Released by the test to control when `ready()` resolves. */
  gate: Promise<void>;
  release: () => void;
}

function stubBundle(options: LazyDecoderOptions): { bundle: LazyDecoderBundle; state: BundleState } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state: BundleState = {
    path: options.path,
    readyCalls: 0,
    disposed: 0,
    decoders: { dracoLoader: { id: "lazy-draco" } },
    gate,
    release,
  };
  const bundle: LazyDecoderBundle = {
    path: options.path,
    current: () => state.decoders,
    ready: async () => {
      state.readyCalls += 1;
      await state.gate;
      return state.decoders;
    },
    dispose: () => {
      state.disposed += 1;
    },
  };
  return { bundle, state };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  el: SceneEditorElement;
  fake: FakeRuntime;
  decoderOptions: LazyDecoderOptions[];
  bundles: BundleState[];
  options: () => RuntimeFactoryOptions | undefined;
}

function makeElement(): Harness {
  const fake = new FakeRuntime();
  let captured: RuntimeFactoryOptions | undefined;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options;
    return fake;
  };
  const decoderOptions: LazyDecoderOptions[] = [];
  const bundles: BundleState[] = [];
  SceneEditorElement.decoderBundleFactory = (options) => {
    decoderOptions.push(options);
    const { bundle, state } = stubBundle(options);
    bundles.push(state);
    return bundle;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake, decoderOptions, bundles, options: () => captured };
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
  SceneEditorElement.decoderBundleFactory = ORIGINAL_DECODER_FACTORY;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  SceneEditorElement.decoderBundleFactory = ORIGINAL_DECODER_FACTORY;
  vi.restoreAllMocks();
});

describe("decoder-path / decoder-cdn", () => {
  it("does not build a bundle without either attribute", async () => {
    const { el, decoderOptions, options } = makeElement();
    await connected(el);

    expect(decoderOptions).toEqual([]);
    expect(options()?.getDecoders?.()).toEqual({
      dracoLoader: null,
      ktx2Loader: null,
      meshoptDecoder: null,
    });
  });

  it("decoder-cdn points at the three-pinned CDN", async () => {
    const { el, decoderOptions, fake } = makeElement();
    el.setAttribute("decoder-cdn", "");
    await connected(el);
    // Release the gate so the pending `src` load can finish.
    const [state] = decoderOptions;
    expect(state?.path).toBe(DEFAULT_DECODER_CDN);
    expect(fake.calls.loadDocument).toHaveLength(0);
  });

  it("decoder-path wins over decoder-cdn", async () => {
    const { el, decoderOptions } = makeElement();
    el.setAttribute("decoder-cdn", "");
    el.setAttribute("decoder-path", "/decoders/");
    await connected(el);

    expect(decoderOptions.at(-1)?.path).toBe("/decoders/");
  });

  it("resolves the bundle before the src load starts", async () => {
    const { el, fake, bundles } = makeElement();
    el.setAttribute("decoder-path", "/decoders/");
    el.setAttribute("src", "compressed.glb");
    await connected(el);
    await nextTick();

    expect(bundles[0]?.readyCalls).toBe(1);
    // Gated: nothing may be fetched with a half-built decoder set.
    expect(fake.calls.loadDocument).toHaveLength(0);

    bundles[0]?.release();
    await nextTick();
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(1);
  });

  it("keeps host-assigned decoders in front of the bundle", async () => {
    const { el, fake, options, bundles } = makeElement();
    el.setAttribute("decoder-path", "/decoders/");
    el.setAttribute("src", "compressed.glb");
    const ktx2 = { name: "host-ktx2" };
    el.ktx2Loader = ktx2;
    await connected(el);
    bundles[0]?.release();
    await nextTick();
    await nextTick();

    // The host object wins for KTX2, the bundle still supplies Draco.
    expect(options()?.getDecoders?.()).toEqual({
      dracoLoader: { id: "lazy-draco" },
      ktx2Loader: ktx2,
      meshoptDecoder: null,
    });
    expect(fake.calls.loadDocument).toHaveLength(1);
  });

  it("rebuilds and disposes the bundle when the attribute changes", async () => {
    const { el, decoderOptions, bundles } = makeElement();
    await connected(el);

    el.setAttribute("decoder-path", "/a/");
    expect(decoderOptions.map((o) => o.path)).toEqual(["/a/"]);

    el.setAttribute("decoder-path", "/b/");
    expect(decoderOptions.map((o) => o.path)).toEqual(["/a/", "/b/"]);
    expect(bundles[0]?.disposed).toBe(1);

    el.removeAttribute("decoder-path");
    expect(bundles[1]?.disposed).toBe(1);
    expect(decoderOptions).toHaveLength(2);
  });

  it("disposes the bundle on disconnect", async () => {
    const { el, bundles } = makeElement();
    el.setAttribute("decoder-cdn", "");
    await connected(el);

    el.remove();

    expect(bundles[0]?.disposed).toBe(1);
  });
});
