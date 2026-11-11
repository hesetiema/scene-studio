import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLazyDecoders,
  decoderCdn,
  DEFAULT_DECODER_CDN,
  type DecoderModules,
} from "../../src/assets/lazy-decoders";

/**
 * The bundle is the only place that knows three's decoder plumbing, so these
 * tests pin the four things that make `decoder-path` work in the browser:
 * lazy imports, the exact payload URLs, "KTX2 only with a real renderer", and
 * "one bad module does not take the others down".
 */

interface FakeDraco {
  path?: string;
  disposed: number;
  setDecoderPath(path: string): unknown;
  dispose(): void;
}

interface FakeKtx2 {
  transcoderPath?: string;
  renderer?: unknown;
  disposed: number;
  setTranscoderPath(path: string): unknown;
  detectSupport(renderer: unknown): unknown;
  dispose(): void;
}

function makeModules(overrides: Partial<DecoderModules> = {}) {
  const created: { draco: FakeDraco[]; ktx2: FakeKtx2[] } = { draco: [], ktx2: [] };
  const meshoptReady = Promise.resolve();

  class DRACOLoader implements FakeDraco {
    path?: string;
    disposed = 0;
    constructor() {
      created.draco.push(this);
    }
    setDecoderPath(path: string): this {
      this.path = path;
      return this;
    }
    dispose(): void {
      this.disposed += 1;
    }
  }

  class KTX2Loader implements FakeKtx2 {
    transcoderPath?: string;
    renderer?: unknown;
    disposed = 0;
    constructor() {
      created.ktx2.push(this);
    }
    setTranscoderPath(path: string): this {
      this.transcoderPath = path;
      return this;
    }
    detectSupport(renderer: unknown): this {
      this.renderer = renderer;
      return this;
    }
    dispose(): void {
      this.disposed += 1;
    }
  }

  const modules: DecoderModules = {
    draco: () => Promise.resolve({ DRACOLoader }),
    ktx2: () => Promise.resolve({ KTX2Loader }),
    meshopt: () => Promise.resolve({ MeshoptDecoder: { ready: meshoptReady } }),
    ...overrides,
  };
  return { modules, created, meshoptReady };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLazyDecoders", () => {
  it("configures every decoder from one base URL", async () => {
    const { modules, created } = makeModules();
    const bundle = createLazyDecoders({ path: "/decoders", modules, getRenderer: () => ({}) });

    await bundle.ready();

    expect(created.draco[0]?.path).toBe("/decoders/draco/gltf/");
    expect(created.ktx2[0]?.transcoderPath).toBe("/decoders/basis/");
    expect(bundle.current()).toEqual({
      dracoLoader: created.draco[0],
      ktx2Loader: created.ktx2[0],
      meshoptDecoder: { ready: expect.anything() },
    });
  });

  it("keeps a trailing slash from doubling up", async () => {
    const { modules, created } = makeModules();
    await createLazyDecoders({ path: "https://cdn.test/libs/", modules }).ready();

    expect(created.draco[0]?.path).toBe("https://cdn.test/libs/draco/gltf/");
  });

  it("imports each module once and hands back the same bundle", async () => {
    const { modules } = makeModules();
    const draco = vi.fn(modules.draco);
    const ktx2 = vi.fn(modules.ktx2);
    const meshopt = vi.fn(modules.meshopt);
    const bundle = createLazyDecoders({
      path: "/d/",
      modules: { draco, ktx2, meshopt },
      getRenderer: () => ({}),
    });

    const [first, second] = await Promise.all([bundle.ready(), bundle.ready()]);
    await bundle.ready();

    expect(first).toBe(second);
    expect(draco).toHaveBeenCalledTimes(1);
    expect(ktx2).toHaveBeenCalledTimes(1);
    expect(meshopt).toHaveBeenCalledTimes(1);
  });

  it("starts empty, so an uncompressed model costs nothing", () => {
    const { modules } = makeModules();
    const bundle = createLazyDecoders({ path: "/d/", modules });

    expect(bundle.current()).toEqual({});
  });

  it("skips KTX2 without a renderer instead of guessing a format", async () => {
    const { modules, created } = makeModules();
    const bundle = createLazyDecoders({ path: "/d/", modules, getRenderer: () => undefined });

    await bundle.ready();

    expect(created.ktx2).toHaveLength(0);
    expect(bundle.current().ktx2Loader).toBeUndefined();
    expect(bundle.current().dracoLoader).toBeDefined();
  });

  it("passes the real renderer to detectSupport", async () => {
    const { modules, created } = makeModules();
    const renderer = { capabilities: {} };
    await createLazyDecoders({ path: "/d/", modules, getRenderer: () => renderer }).ready();

    expect(created.ktx2[0]?.renderer).toBe(renderer);
  });

  it("awaits MeshoptDecoder.ready before handing it over", async () => {
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const { modules } = makeModules({
      meshopt: () => Promise.resolve({ MeshoptDecoder: { ready } }),
    });
    const bundle = createLazyDecoders({ path: "/d/", modules });

    let settled = false;
    const pending = bundle.ready().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveReady();
    await pending;
    expect(bundle.current().meshoptDecoder).toBeDefined();
  });

  it("drops a decoder whose module fails to import, keeps the rest", async () => {
    const { modules } = makeModules({
      draco: () => Promise.reject(new Error("blocked by CSP")),
    });
    const bundle = createLazyDecoders({ path: "/d/", modules, getRenderer: () => ({}) });

    const decoders = await bundle.ready();

    expect(decoders.dracoLoader).toBeUndefined();
    expect(decoders.ktx2Loader).toBeDefined();
    expect(decoders.meshoptDecoder).toBeDefined();
  });

  it("survives a Meshopt wasm that never becomes ready", async () => {
    const { modules } = makeModules({
      meshopt: () => Promise.resolve({ MeshoptDecoder: { ready: Promise.reject(new Error("no wasm")) } }),
    });
    const bundle = createLazyDecoders({ path: "/d/", modules });

    await expect(bundle.ready()).resolves.toBeDefined();
  });

  it("disposes the workers and stops handing out decoders", async () => {
    const { modules, created } = makeModules();
    const bundle = createLazyDecoders({ path: "/d/", modules, getRenderer: () => ({}) });
    await bundle.ready();

    bundle.dispose();

    expect(created.draco[0]?.disposed).toBe(1);
    expect(created.ktx2[0]?.disposed).toBe(1);
    expect(bundle.current()).toEqual({});
    await expect(bundle.ready()).resolves.toEqual({});
  });

  it("disposes decoders that finish configuring after teardown", async () => {
    const { modules, created } = makeModules();
    const bundle = createLazyDecoders({ path: "/d/", modules, getRenderer: () => ({}) });

    const pending = bundle.ready();
    bundle.dispose();
    await pending;

    expect(created.draco[0]?.disposed).toBe(1);
    expect(bundle.current()).toEqual({});
  });
});

describe("decoderCdn", () => {
  it("pins the payloads to the three version the SDK was built against", () => {
    // A r186 wrapper against an r180 wasm is undefined behaviour, so the URL
    // must follow `REVISION` rather than float.
    expect(decoderCdn("186")).toBe(
      "https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/",
    );
    expect(DEFAULT_DECODER_CDN).toBe(decoderCdn());
    expect(DEFAULT_DECODER_CDN.endsWith("/examples/jsm/libs/")).toBe(true);
  });
});
