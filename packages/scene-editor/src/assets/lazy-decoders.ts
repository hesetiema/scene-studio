import { REVISION } from "three";
import type { GltfDecoders } from "./gltf-asset-loader";

/**
 * Lazy decoder bundle (0.7.1).
 *
 * A compressed glTF is not loadable without its decoder, and three is explicit
 * about it: `GLTFLoader` throws "setDRACOLoader must be called before loading"
 * unless the host constructed a `DRACOLoader` (with a decoder path), a
 * `KTX2Loader` (with a transcoder path *and* `detectSupport(renderer)`) and/or
 * `MeshoptDecoder`. Asking every `<scene-editor src>` user to assemble that by
 * hand is why "open a Draco GLB" used to fail out of the box.
 *
 * This module assembles it from a single base URL. The cost is bounded and paid
 * once:
 *
 * - the addon modules themselves are dynamic `import()`s, so they are their own
 *   chunk and never part of the main bundle; they are fetched on the first load
 *   of a page that opted in (`decoder-path` / `decoder-cdn`), because three
 *   needs the instances before it parses;
 * - `DRACOLoader` is only *configured* here — the draco wasm and the KTX2
 *   transcoder are fetched by three itself, inside the first compressed
 *   primitive/texture, so a page of uncompressed models downloads no payloads
 *   at all;
 * - `MeshoptDecoder` is a wasm module that has to be awaited once, and KTX2
 *   cannot work without the real renderer (`detectSupport` probes device
 *   support), so it is skipped — not faked — when no renderer is available.
 */

/**
 * Payload layout, i.e. three's own `examples/jsm/libs` directory:
 *
 * ```
 * <decoder-path>/
 *   draco/gltf/draco_wasm_wrapper.js + draco_decoder.wasm
 *   basis/basis_transcoder.js + basis_transcoder.wasm
 * ```
 *
 * Copying `node_modules/three/examples/jsm/libs/{draco,basis}` to the base URL
 * is the whole self-hosting story; the `gltf/` build is the one targeted at
 * `KHR_draco_mesh_compression`, which is all this SDK loads.
 */
export const DECODER_PAYLOAD_LAYOUT = "draco/gltf + basis";

/**
 * Default CDN base for `decoder-cdn`, pinned to the three version this build
 * was compiled against: decoder payloads are version-coupled (a r186 wrapper
 * against an r180 wasm is undefined behaviour), and jsDelivr serves the files
 * straight out of the npm package with permissive CORS.
 */
export function decoderCdn(version: string = REVISION): string {
  return `https://cdn.jsdelivr.net/npm/three@0.${version}.0/examples/jsm/libs/`;
}

export const DEFAULT_DECODER_CDN = decoderCdn();

/** The slice of three's `DRACOLoader` the bundle touches. */
export interface DracoLoaderLike {
  setDecoderPath(path: string): unknown;
  dispose?(): void;
}

/** The slice of three's `KTX2Loader` the bundle touches. */
export interface Ktx2LoaderLike {
  setTranscoderPath(path: string): unknown;
  detectSupport(renderer: unknown): unknown;
  dispose?(): void;
}

/**
 * The three modules the bundle needs, as an injectable seam: unit tests swap
 * them for stubs, production uses the real dynamic imports below. Each entry
 * is a thunk so nothing is imported until `ready()` runs.
 */
export interface DecoderModules {
  draco: () => Promise<{ DRACOLoader: new () => DracoLoaderLike }>;
  ktx2: () => Promise<{ KTX2Loader: new () => Ktx2LoaderLike }>;
  meshopt: () => Promise<{ MeshoptDecoder: unknown }>;
}

const DEFAULT_MODULES: DecoderModules = {
  draco: () => import("three/examples/jsm/loaders/DRACOLoader.js"),
  ktx2: () => import("three/examples/jsm/loaders/KTX2Loader.js"),
  meshopt: () => import("three/examples/jsm/libs/meshopt_decoder.module.js"),
};

export interface LazyDecoderOptions {
  /** Base URL holding `draco/gltf/` and `basis/` (see {@link DECODER_PAYLOAD_LAYOUT}). */
  path: string;
  /**
   * Renderer accessor for `KTX2Loader.detectSupport()`. KTX2 is skipped when
   * this is missing or returns nothing — a transcoder that guessed the device
   * format would produce broken textures, so silence beats a lie.
   */
  getRenderer?: () => unknown;
  /** Test seam. */
  modules?: DecoderModules;
}

export interface LazyDecoderBundle {
  /** The base URL this bundle was built from. */
  readonly path: string;
  /** Configured decoders; `{}` until `ready()` resolves. */
  current(): GltfDecoders;
  /** Import and configure once; later calls return the same object. */
  ready(): Promise<GltfDecoders>;
  /** Terminate the decoder workers (Draco/KTX2 keep one each). */
  dispose(): void;
}

function withTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

function disposeDecoders(decoders: GltfDecoders): void {
  for (const decoder of [decoders.dracoLoader, decoders.ktx2Loader]) {
    try {
      (decoder as { dispose?: () => void } | undefined)?.dispose?.();
    } catch {
      // Best-effort: a worker that refuses to stop must not break teardown.
    }
  }
}

/**
 * Build a decoder set from one base URL. `ready()` is idempotent and never
 * rejects: a module that fails to import (offline CDN, blocked worker) drops
 * that decoder only, and the load then fails with an actionable message
 * instead of a stack trace from inside three.
 */
export function createLazyDecoders(options: LazyDecoderOptions): LazyDecoderBundle {
  const base = withTrailingSlash(options.path);
  const modules = options.modules ?? DEFAULT_MODULES;
  let current: GltfDecoders = {};
  let pending: Promise<GltfDecoders> | null = null;
  let disposed = false;

  async function configure(): Promise<GltfDecoders> {
    // Probe the renderer first: without one, KTX2 must be skipped anyway, and
    // then its module never has to be downloaded at all.
    const renderer = options.getRenderer?.();
    const [draco, ktx2, meshopt] = await Promise.all([
      modules.draco().catch(() => null),
      renderer ? modules.ktx2().catch(() => null) : Promise.resolve(null),
      modules.meshopt().catch(() => null),
    ]);
    const decoders: GltfDecoders = {};

    if (draco) {
      // Configure now, fetch later: three only pulls the wasm when it meets a
      // `KHR_draco_mesh_compression` primitive (`DRACOLoader._initDecoder`).
      const loader = new draco.DRACOLoader();
      loader.setDecoderPath(`${base}draco/gltf/`);
      decoders.dracoLoader = loader;
    }

    if (ktx2 && renderer) {
      const loader = new ktx2.KTX2Loader();
      loader.setTranscoderPath(`${base}basis/`);
      loader.detectSupport(renderer);
      decoders.ktx2Loader = loader;
    }

    if (meshopt) {
      const decoder = meshopt.MeshoptDecoder as { ready?: Promise<unknown> } | undefined;
      if (decoder) {
        // The wasm module resolves `ready` once it can decode; handing it over
        // earlier makes GLTFLoader throw mid-parse.
        try {
          await decoder.ready;
        } catch {
          // A broken wasm build drops Meshopt only.
        }
        decoders.meshoptDecoder = decoder;
      }
    }

    return decoders;
  }

  return {
    path: base,
    current: () => current,
    ready() {
      if (disposed) return Promise.resolve(current);
      pending ??= configure().then((decoders) => {
        if (disposed) {
          disposeDecoders(decoders);
          return current;
        }
        current = decoders;
        return current;
      });
      return pending;
    },
    dispose() {
      disposed = true;
      disposeDecoders(current);
      current = {};
      pending = null;
    },
  };
}
