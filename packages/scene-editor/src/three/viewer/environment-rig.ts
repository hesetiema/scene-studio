import * as THREE from "three";
import type {
  EnvironmentHdrDTO,
  EnvironmentSkyboxDTO,
  ViewState,
} from "../../core/document/schema";
import type { EnvironmentPreset } from "../../runtime/runtime-contract";
import { NEUTRAL_KEY_OFFSET } from "./neutral-environment";

/**
 * Key-light direction per built-in preset (scene → light, unit length).
 *
 * `neutral` is our own studio, so the key softbox position *is* the answer.
 * `room` is dominated by `RoomEnvironment`'s overhead `mainLight`
 * (`PointLight` at `0.418 16.199 0.300`, intensity 900) plus the window strips.
 */
const PRESET_KEY_DIRECTIONS: Record<EnvironmentPreset, [number, number, number]> = {
  neutral: normalizeDirection(NEUTRAL_KEY_OFFSET),
  room: normalizeDirection([0.418, 16.199, 0.3]),
  // `legacy` is model-viewer's old default; we alias it to the room studio.
  legacy: normalizeDirection([0.418, 16.199, 0.3]),
};

function normalizeDirection([x, y, z]: readonly [number, number, number]): [
  number,
  number,
  number,
] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export type EnvironmentView = ViewState["environment"];

/** IBL strength used when the document omits it (1 = raw environment luminance). */
export const DEFAULT_IBL_INTENSITY = 1;

export interface EnvironmentRigOptions {
  /**
   * Real WebGL renderer — PMREM needs a GPU context. WebGPU renderers and test
   * stubs do not expose `isWebGLRenderer`, so IBL silently degrades to plain lights.
   */
  renderer?: unknown;
  /** assetId → URL, the same seam meshes use. Without it, HDR requests are ignored. */
  resolveAsset?: (assetId: string) => Promise<string>;
  /** Fired once the environment map finished generating (the runtime re-renders). */
  onEnvironmentReady?: () => void;
  /** Fired when an HDR could not be loaded; the studio room stays in use. */
  onHdrError?: (error: unknown, source: string) => void;
  /** Fired when a skybox image could not be loaded; the plain backdrop stays. */
  onSkyboxError?: (error: unknown, source: string) => void;
  /** Built-in studio IBL to prefilter first (default `"room"`). */
  preset?: EnvironmentPreset;
}

export interface EnvironmentRig {
  readonly grid: THREE.GridHelper;
  readView(): EnvironmentView;
  applyView(view: EnvironmentView): void;
  setBackground(background: string | null): void;
  setGridVisible(visible: boolean): void;
  /** 0 = pure analytic lights; > 0 = environment map luminance multiplier. */
  setIblIntensity(intensity: number): void;
  /** Swap the built-in studio IBL; inert while a document HDR is in use. */
  setPreset(preset: EnvironmentPreset): void;
  /**
   * Direction the active studio's key light comes from (unit vector, scene →
   * light), so the contact shadow can fall with the IBL highlight instead of an
   * arbitrary authored direction.
   */
  keyDirection(): [number, number, number];
  /** Swap in (or clear) an HDR/EXR environment; async, last call wins. */
  setHdr(hdr: EnvironmentHdrDTO | undefined): void;
  /**
   * The same, from a bare URL — model-viewer's `environment-image` when it names
   * a file instead of a preset. The value *is* the URL, so the asset resolver is
   * bypassed (it maps document asset ids, not absolute paths). `null` hands the
   * IBL back to the preset (and to a document HDR, if there is one).
   */
  setHdrUrl(url: string | null): void;
  /** Visible backdrop, independent of the IBL; async, last call wins. */
  setSkybox(skybox: EnvironmentSkyboxDTO | undefined): void;
  /**
   * `skybox-image`. `asEnvironment` mirrors model-viewer: a skybox with no
   * explicit `environment-image` also lights the model, from one download.
   */
  setSkyboxUrl(url: string | null, asEnvironment?: boolean): void;
  /** Latest HDR texture, so the contact shadow can share its light probe. */
  readonly hdrTexture: THREE.Texture | null;
  dispose(): void;
}

/** Equirectangular HDR / EXR / LDR image → texture, format picked by extension. */
async function loadEquirectTexture(url: string): Promise<THREE.Texture> {
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase();

  if (ext === "hdr") {
    // three r186 renamed RGBELoader → HDRLoader (the old name is a deprecated
    // alias). Same Radiance format, so a `.hdr` panorama loads either way.
    const { HDRLoader } = await import("three/examples/jsm/loaders/HDRLoader.js");
    const texture = await new HDRLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }

  if (ext === "exr") {
    const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
    const texture = await new EXRLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }

  // LDR panoramas (jpg/png) still work as a light probe; they just carry less range.
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Backdrop + floor grid + image-based lighting (reference: `updateBackground` /
 * `updateDisplay` / `updateEnvironment`).
 *
 * `background: null` stays transparent to preserve the pre-D22 look. Without an
 * HDR the environment map is three's built-in `RoomEnvironment`, prefiltered
 * through PMREM — no network asset, and metals/glass pick up reflections instead
 * of rendering black under analytic lights alone.
 *
 * `iblIntensity` is the global multiplier; `hdr.intensity` scales on top of it,
 * so setting `iblIntensity: 0` turns IBL off whether or not an HDR is present.
 */
export function createEnvironmentRig(
  scene: THREE.Scene,
  initial: EnvironmentView,
  options: EnvironmentRigOptions = {},
): EnvironmentRig {
  const grid = new THREE.GridHelper(10, 10);
  grid.visible = initial.gridVisible;
  scene.add(grid);

  let iblIntensity = initial.iblIntensity ?? DEFAULT_IBL_INTENSITY;
  let backgroundColor: string | null = initial.background;
  let hdr: EnvironmentHdrDTO | undefined = initial.hdr;
  let skybox: EnvironmentSkyboxDTO | undefined = initial.skybox;

  let preset: EnvironmentPreset = options.preset ?? "room";
  let studioTexture: THREE.Texture | null = null;
  /** Preset the cached `studioTexture` came from (`null` before the first build). */
  let studioPreset: EnvironmentPreset | null = null;
  let hdrTexture: THREE.Texture | null = null;
  let skyboxTexture: THREE.Texture | null = null;
  /** Set while `environment-image`/`skybox-image` (not the document) owns the IBL. */
  let hdrIsViewerOverride = false;
  /** True while the backdrop texture is *also* lighting the model. */
  let skyboxLightsScene = false;
  let studioRequest: Promise<void> | null = null;
  /** Bumped on every `setHdr`; a slow load that lost the race disposes itself. */
  let hdrToken = 0;
  let skyboxToken = 0;
  let disposed = false;

  const renderer = options.renderer as { isWebGLRenderer?: boolean } | null | undefined;
  const canUsePmrem = renderer?.isWebGLRenderer === true;

  const prefilter = (source: THREE.Texture): THREE.Texture => {
    const pmrem = new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer);
    const target = pmrem.fromEquirectangular(source);
    pmrem.dispose();
    return target.texture;
  };

  const applyBackground = (): void => {
    // Precedence: a dedicated skybox wins over "show the IBL" wins over a colour.
    if (skyboxTexture) {
      scene.background = skyboxTexture;
      scene.backgroundIntensity = skybox?.intensity ?? 1;
      return;
    }
    scene.backgroundIntensity = 1;
    // `hdrIsViewerOverride` means `environment-image` took the IBL over: the
    // document's own `asBackground` intent was about the document's own HDR.
    if (!hdrIsViewerOverride && hdr?.asBackground === true && hdrTexture) {
      scene.background = hdrTexture;
      return;
    }
    scene.background = backgroundColor === null ? null : new THREE.Color(backgroundColor);
  };

  const applyEnvironment = (): void => {
    const texture = hdrTexture ?? studioTexture;
    const intensity = iblIntensity * (hdrIsViewerOverride ? 1 : (hdr?.intensity ?? 1));
    if (intensity <= 0 || !texture) {
      scene.environment = null;
      return;
    }
    scene.environment = texture;
    scene.environmentIntensity = intensity;
  };

  /** Prefilter one built-in preset; `null` when there is no usable GPU. */
  const prefilterPreset = async (which: EnvironmentPreset): Promise<THREE.Texture | null> => {
    const pmrem = new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer);
    try {
      if (which === "neutral") {
        const { createNeutralEnvironment } = await import("./neutral-environment");
        const environment = createNeutralEnvironment();
        try {
          return pmrem.fromScene(environment.scene, 0.04).texture;
        } finally {
          environment.dispose();
        }
      }
      const { RoomEnvironment } = await import(
        "three/examples/jsm/environments/RoomEnvironment.js"
      );
      const room = new RoomEnvironment();
      try {
        return pmrem.fromScene(room, 0.04).texture;
      } finally {
        (room as { dispose?: () => void }).dispose?.();
      }
    } finally {
      pmrem.dispose();
    }
  };

  /** Lazily (re)prefilter the selected studio preset; never rejects. */
  const ensureStudio = (): void => {
    if (studioRequest || disposed || !canUsePmrem) return;
    if (studioTexture !== null && studioPreset === preset) return;

    const wanted = preset;
    studioRequest = (async () => {
      try {
        const texture = await prefilterPreset(wanted);
        if (!texture) return;
        // Lost the race against a preset switch or teardown: drop the result.
        if (disposed || wanted !== preset) {
          texture.dispose();
          return;
        }

        studioTexture?.dispose();
        studioTexture = texture;
        studioPreset = wanted;
        applyEnvironment();
        applyBackground();
        options.onEnvironmentReady?.();
      } catch {
        // No usable GPU context — keep rendering with analytic lights only.
      } finally {
        studioRequest = null;
      }
    })().finally(() => {
      // A switch during the build left the cache stale: rebuild exactly once.
      if (!disposed && studioPreset !== preset) ensureStudio();
    });
  };

  /**
   * Load → prefilter → swap the IBL. `null` clears back to the studio preset.
   *
   * `hdrToken` makes this last-call-wins: a slower load that lost the race
   * disposes whatever it produced instead of overwriting the newer map.
   */
  const swapHdr = (load: (() => Promise<string>) | null, sourceUrl: string): void => {
    const token = ++hdrToken;

    if (load === null) {
      hdrTexture?.dispose();
      hdrTexture = null;
      applyEnvironment();
      applyBackground();
      ensureStudio();
      return;
    }
    // No GPU context: PMREM cannot run, so the studio stays in charge.
    if (!canUsePmrem) return;

    void (async () => {
      let source: THREE.Texture | null = null;
      try {
        source = await loadEquirectTexture(await load());
        if (disposed || token !== hdrToken) {
          source.dispose();
          return;
        }

        const prefiltered = prefilter(source);
        source.dispose();
        source = null;

        if (disposed || token !== hdrToken) {
          prefiltered.dispose();
          return;
        }

        hdrTexture?.dispose();
        hdrTexture = prefiltered;
        applyEnvironment();
        applyBackground();
        options.onEnvironmentReady?.();
      } catch (error) {
        source?.dispose();
        if (disposed || token !== hdrToken) return;
        // Keep the studio room: a broken HDR must not black out the scene.
        options.onHdrError?.(error, sourceUrl);
      }
    })();
  };

  /**
   * Load → swap the backdrop. `asEnvironment` is model-viewer's rule that a
   * skybox with no explicit `environment-image` also lights the model; the
   * single download is then prefilted once for the IBL.
   */
  const swapSkybox = (
    load: (() => Promise<string>) | null,
    sourceUrl: string,
    asEnvironment: boolean,
  ): void => {
    const token = ++skyboxToken;

    if (load === null) {
      skyboxTexture?.dispose();
      skyboxTexture = null;
      if (skyboxLightsScene) {
        skyboxLightsScene = false;
        // The backdrop was the IBL too: fall back to the preset studio.
        if (!hdrIsViewerOverride) {
          hdrTexture?.dispose();
          hdrTexture = null;
          applyEnvironment();
          ensureStudio();
        }
      }
      applyBackground();
      return;
    }

    void (async () => {
      let source: THREE.Texture | null = null;
      try {
        source = await loadEquirectTexture(await load());
        if (disposed || token !== skyboxToken) {
          source.dispose();
          return;
        }

        // A backdrop is only *seen*, unless it doubles as the light probe.
        const prefiltered = asEnvironment && canUsePmrem ? prefilter(source) : null;
        if (disposed || token !== skyboxToken) {
          source.dispose();
          prefiltered?.dispose();
          return;
        }

        skyboxTexture?.dispose();
        skyboxTexture = source;
        source = null;
        skyboxLightsScene = prefiltered !== null;
        if (prefiltered) {
          hdrTexture?.dispose();
          hdrTexture = prefiltered;
          hdrIsViewerOverride = true;
          applyEnvironment();
        }
        applyBackground();
        options.onEnvironmentReady?.();
      } catch (error) {
        source?.dispose();
        if (disposed || token !== skyboxToken) return;
        // Keep the previous backdrop: a broken panorama must not black out.
        options.onSkyboxError?.(error, sourceUrl);
      }
    })();
  };

  const rig: EnvironmentRig = {
    grid,
    get hdrTexture(): THREE.Texture | null {
      return hdrTexture;
    },
    readView(): EnvironmentView {
      return {
        background: backgroundColor,
        gridVisible: grid.visible,
        iblIntensity,
        ...(hdr === undefined ? {} : { hdr }),
        ...(skybox === undefined ? {} : { skybox }),
      };
    },
    applyView(view: EnvironmentView): void {
      rig.setBackground(view.background);
      rig.setGridVisible(view.gridVisible);
      rig.setIblIntensity(view.iblIntensity ?? DEFAULT_IBL_INTENSITY);
      rig.setHdr(view.hdr);
      rig.setSkybox(view.skybox);
    },
    setBackground(background: string | null): void {
      backgroundColor = background;
      applyBackground();
    },
    setGridVisible(visible: boolean): void {
      grid.visible = visible;
    },
    setIblIntensity(intensity: number): void {
      iblIntensity = Number.isFinite(intensity)
        ? Math.max(0, intensity)
        : DEFAULT_IBL_INTENSITY;
      applyEnvironment();
      ensureStudio();
    },
    setPreset(next: EnvironmentPreset): void {
      if (next === preset) {
        ensureStudio();
        return;
      }
      preset = next;
      // The previous map stays on screen until the new one is filtered: no flash.
      ensureStudio();
    },
    keyDirection(): [number, number, number] {
      return PRESET_KEY_DIRECTIONS[preset];
    },
    setHdr(next: EnvironmentHdrDTO | undefined): void {
      hdr = next;
      hdrIsViewerOverride = false;
      const resolve = options.resolveAsset;
      if (next !== undefined && !resolve) return;
      swapHdr(next === undefined ? null : () => resolve!(next.assetId), next?.assetId ?? "");
    },
    setHdrUrl(url: string | null): void {
      if (url !== null) {
        hdrIsViewerOverride = true;
        swapHdr(() => Promise.resolve(url), url);
        return;
      }
      // Hand the IBL back: the document's HDR if it had one, else the preset.
      // A backdrop that took over the lighting keeps it — model-viewer's rule
      // is "skybox lights the model when no environment-image is set", and
      // clearing the attribute is that state again.
      if (skyboxLightsScene) return;
      hdrIsViewerOverride = false;
      if (hdr !== undefined && options.resolveAsset) {
        swapHdr(() => options.resolveAsset!(hdr!.assetId), hdr.assetId);
        return;
      }
      swapHdr(null, "");
    },
    setSkybox(next: EnvironmentSkyboxDTO | undefined): void {
      skybox = next;
      const resolve = options.resolveAsset;
      if (next !== undefined && !resolve) return;
      // A document skybox stays a backdrop: `view.hdr` remains the light probe.
      swapSkybox(
        next === undefined ? null : () => resolve!(next.assetId),
        next?.assetId ?? "",
        false,
      );
    },
    setSkyboxUrl(url: string | null, asEnvironment = false): void {
      // `skybox` describes the document DTO; a viewer URL has no intensity of
      // its own, so drop it and let `backgroundIntensity` fall back to 1.
      skybox = undefined;
      swapSkybox(url === null ? null : () => Promise.resolve(url), url ?? "", asEnvironment);
    },
    dispose(): void {
      disposed = true;
      scene.remove(grid);
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) material.dispose();

      if (
        scene.background === hdrTexture ||
        scene.background === studioTexture ||
        scene.background === skyboxTexture
      ) {
        scene.background = null;
      }
      scene.environment = null;
      hdrTexture?.dispose();
      hdrTexture = null;
      skyboxTexture?.dispose();
      skyboxTexture = null;
      studioTexture?.dispose();
      studioTexture = null;
      studioPreset = null;
    },
  };

  rig.setBackground(backgroundColor);
  rig.setGridVisible(initial.gridVisible);
  rig.setIblIntensity(iblIntensity);
  if (hdr !== undefined) rig.setHdr(hdr);
  if (skybox !== undefined) rig.setSkybox(skybox);
  return rig;
}
