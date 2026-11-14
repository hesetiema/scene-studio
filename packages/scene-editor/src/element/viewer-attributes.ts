import type {
  CameraOrbitLimits,
  DisplayModeId,
  EnvironmentPreset,
  RuntimeContract,
  ToneMappingMode,
} from "../runtime/runtime-contract";
import type { ViewState } from "../core/document/schema";
import {
  ORBIT_AXES,
  cameraFromOrbit,
  orbitFromCamera,
  parseAngle,
  parseOrbitToken,
  parseVector3,
  type CameraView,
} from "./attribute-math";

/**
 * Attribute → runtime projection.
 *
 * Every method here has the same shape: read a declarative attribute, translate
 * it (via `attribute-math` or a small local parser), and call the runtime. None
 * of them owns scene state — the only memory in this module is the signature of
 * the last applied camera pose, which exists so the post-load re-assert can
 * stand down without snapping a user's drag back.
 *
 * That is exactly why it is separable: the element owns *when* things happen
 * (connect, load, attribute change) and this owns *what an attribute means*.
 * The five-member host below is the entire contract between them.
 */

const TONE_MAPPING_MODES: readonly ToneMappingMode[] = [
  "none",
  "linear",
  "aces",
  "agx",
  "neutral",
];

const DISPLAY_MODE_IDS: readonly DisplayModeId[] = [
  "studio",
  "xray",
  "wireframe",
  "normal",
  "clay",
];

/** `touch-action` keywords the element forwards verbatim. */
const TOUCH_ACTION_KEYWORDS: ReadonlySet<string> = new Set(["none", "pan-x", "pan-y"]);
/** model-viewer's own default: vertical page scroll wins over an orbit drag. */
const DEFAULT_TOUCH_ACTION = "pan-y";

/** model-viewer's `interpolation-decay` default, in milliseconds. */
const DEFAULT_INTERPOLATION_DECAY = 50;

/** OrbitControls' own default `dampingFactor`. */
const DEFAULT_DAMPING = 0.08;

function normalizeToneMapping(value: string): ToneMappingMode | null {
  const lower = value.toLowerCase();
  return (TONE_MAPPING_MODES as readonly string[]).includes(lower)
    ? (lower as ToneMappingMode)
    : null;
}

/** `display-mode`; invalid spellings are ignored (not guessed into a mode). */
export function displayModeFrom(value: string | null): DisplayModeId | null {
  if (value === null) return null;
  const lower = value.trim().toLowerCase();
  return (DISPLAY_MODE_IDS as readonly string[]).includes(lower)
    ? (lower as DisplayModeId)
    : null;
}

/** `explode` as 0..1; `null` (absent) means 0, invalid text means 0. */
/** `explode` as 0..1; `null` (absent) means 0, invalid text means 0. */
export function explodeFrom(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

/** 0..1 range for opacity-like attributes; `NaN` collapses to 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function readNumberAttr(el: HTMLElement, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readOrbitLimits(el: HTMLElement): CameraOrbitLimits | undefined {
  const minRaw = el.getAttribute("min-camera-orbit");
  const maxRaw = el.getAttribute("max-camera-orbit");
  if (minRaw === null && maxRaw === null) return undefined;

  const minTokens = (minRaw ?? "").trim().split(/\s+/);
  const maxTokens = (maxRaw ?? "").trim().split(/\s+/);
  const limits: CameraOrbitLimits = {};
  for (const [index, axis] of ORBIT_AXES.entries()) {
    const low = parseOrbitToken(minTokens[index], axis);
    const high = parseOrbitToken(maxTokens[index], axis);
    // `auto` on either side means "unlimited" — a half-open range is not a range.
    if (low === undefined || high === undefined || low > high) continue;
    limits[axis] = [low, high] as const;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * `camera-damping="0.08"` → inertia factor. Absent means "no inertia", which is
 * what a render-on-demand editor wants; a bare attribute gets the addon default.
 */
function readDamping(el: HTMLElement): number | undefined {
  if (!el.hasAttribute("camera-damping")) return undefined;
  const raw = Number.parseFloat(el.getAttribute("camera-damping") ?? "");
  return Number.isFinite(raw) ? clamp01(raw) : DEFAULT_DAMPING;
}

/** The slice of the host element this module drives. */
export interface ViewerAttributesHost {
  /** The custom element: the attribute source and the canvas' owner. */
  readonly element: HTMLElement;
  /** The mounted runtime; `null` before init and after teardown. */
  runtime(): RuntimeContract | null;
  /** Canvas the element created — `alt` and `touch-action` land on it. */
  canvas(): HTMLCanvasElement | null;
  /**
   * Who owns the document. A host-owned one keeps the `room` preset; a `src`
   * preview defaults to `neutral`, matching model-viewer's `tone-mapping="auto"`
   * on a glTF asset.
   */
  documentOwner(): "host" | "src" | null;
  /**
   * `pause()` outranks `autoplay` — including for later loads. Read here so the
   * playback projection cannot resurrect a transport the host stopped.
   */
  explicitPause(): boolean;
}

/**
 * Applies every declarative attribute to the runtime.
 *
 * Stateless apart from `#appliedCameraPose`. Construct once per element; the
 * host callbacks are read at call time, so it is safe to build in a field
 * initializer before the runtime exists.
 */
export class ViewerAttributes {
  readonly #host: ViewerAttributesHost;
  /** Signature of the last applied `camera-orbit|-target|-field-of-view` triple. */
  #appliedCameraPose: string | null = null;

  constructor(host: ViewerAttributesHost) {
    this.#host = host;
  }

  #attr(name: string): string | null {
    return this.#host.element.getAttribute(name);
  }

  #src(): string | null {
    const value = this.#host.element.getAttribute("src");
    return value ? value : null;
  }

  /**
   * `environment-image` resolved to a preset: the attribute wins when it names
   * one, otherwise `src` previews default to `neutral` and host-owned documents
   * keep `room` (a document carries its own `view.environment`).
   */
  environmentPreset(): EnvironmentPreset {
    const raw = (this.#attr("environment-image") ?? "").trim().toLowerCase();
    if (raw === "neutral" || raw === "room" || raw === "legacy") return raw;
    return this.#src() !== null && this.#host.documentOwner() !== "host" ? "neutral" : "room";
  }

  /**
   * `environment-image` as a file URL, or `null` when it names a preset (or is
   * unset). model-viewer accepts `neutral`, `legacy` or a URL in the same
   * attribute, so the value's shape — not a separate flag — decides.
   */
  get #environmentImageUrl(): string | null {
    const raw = (this.#attr("environment-image") ?? "").trim();
    if (raw === "") return null;
    const lower = raw.toLowerCase();
    return lower === "neutral" || lower === "room" || lower === "legacy" ? null : raw;
  }

  /**
   * Apply the lighting side of `environment-image` / `skybox-image`.
   *
   * Order matters: the preset goes first (it owns the fallback IBL), then the
   * URL override takes the reflection over, then the backdrop — because
   * model-viewer lets a skybox light the model only when no `environment-image`
   * is set, and deciding that needs to see the other attribute.
   */
  applyEnvironmentPreset(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;
    runtime.setEnvironmentPreset?.(this.environmentPreset());
    runtime.setEnvironmentImage?.(this.#environmentImageUrl);
    this.#applySkyboxImage();
  }

  /** `skybox-image`: the visible backdrop, and the IBL too when nothing else is. */
  #applySkyboxImage(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;
    const url = (this.#attr("skybox-image") ?? "").trim() || null;
    runtime.setSkyboxImage?.(url, {
      asEnvironment: url !== null && this.#environmentImageUrl === null,
    });
  }

  /**
   * `alt` — the canvas is the accessible representation of the model
   * (model-viewer parity). Without the attribute the label falls back to the
   * file name, which beats an unlabelled canvas: a screen-reader user then hears
   * *something* instead of "graphic".
   */
  applyAlt(): void {
    const canvas = this.#host.canvas();
    if (!canvas) return;
    canvas.setAttribute("role", "img");
    const text = this.#attr("alt")?.trim() || this.#fallbackAlt();
    if (text) canvas.setAttribute("aria-label", text);
    else canvas.removeAttribute("aria-label");
  }

  #fallbackAlt(): string {
    const name = this.#src()?.split(/[?#]/)[0]?.split("/").pop() ?? "";
    return name ? `3D model: ${name}` : "";
  }

  /**
   * Display-only settings. `src` previews default to `neutral` because that is
   * what model-viewer's `tone-mapping="auto"` resolves to on a glTF asset
   * (measured: identical mean/p95 luminance on the Khronos Fox, while ACES
   * renders ~35% darker and more saturated). Documents loaded through
   * `loadDocument()` keep three's default unless the host opts in.
   */
  applyDisplaySettings(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;

    const mode = this.#attr("tone-mapping") ?? (this.#src() ? "neutral" : null);
    if (mode) {
      const normalized = normalizeToneMapping(mode);
      if (normalized) runtime.setToneMapping?.(normalized);
    }

    const rawExposure = this.#attr("exposure");
    if (rawExposure !== null) {
      const exposure = Number(rawExposure);
      if (Number.isFinite(exposure)) runtime.setExposure?.(exposure);
    }

    // Shading overlay + component explode: both presentation-only, both
    // re-asserted after a load (the runtime resets explode on document swap).
    const rawMode = this.#attr("display-mode");
    runtime.setDisplayMode?.(displayModeFrom(rawMode) ?? "studio");
    runtime.setExplode?.(explodeFrom(this.#attr("explode")));

    this.#applyShadowSettings();
    this.#applyVariantName();
    // An authored camera is a complete pose, so it gets the first word;
    // `applyCameraPose` stands down while one is selected.
    this.#applyCameraName();
    this.applyCameraPose();
  }

  /**
   * Re-run the display settings after a load. Unlike the attribute path this
   * also forgets the applied camera pose: the document's own `view` is restored
   * after the `load` event, which silently overwrites whatever the attributes
   * applied before it.
   */
  reassertDisplaySettings(): void {
    // Forget the applied pose so the post-load application snaps to the
    // document's own `view` instead of fading toward it.
    this.#appliedCameraPose = null;
    this.applyDisplaySettings();
  }

  /**
   * `camera-orbit` / `camera-target` / `field-of-view` — model-viewer's
   * declarative pose.
   *
   * Only the axes a host actually spells out are touched: `camera-orbit="auto
   * auto 2m"` keeps the current angles and just moves the eye, which is what
   * `auto` means in model-viewer. The pose goes through `applyViewState` on the
   * *runtime*, never the document — a viewer attribute must not dirty the scene
   * (the persisted pose stays `view.camera`).
   *
   * `force` is what keeps the two paths apart: an attribute *change* always
   * applies, while the post-load re-assert applies once and then stands down, so
   * an unrelated `tone-mapping` tweak cannot snap a user's drag back.
   */
  applyCameraPose(force = false): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;
    // `camera-name` owns the whole pose while it is set.
    if (this.#cameraName() !== null) return;

    const orbitRaw = this.#attr("camera-orbit");
    const targetRaw = this.#attr("camera-target");
    const fovRaw = this.#attr("field-of-view");
    if (orbitRaw === null && targetRaw === null && fovRaw === null) {
      this.#appliedCameraPose = null;
      return;
    }
    const signature = `${orbitRaw ?? ""}|${targetRaw ?? ""}|${fovRaw ?? ""}`;
    if (!force && signature === this.#appliedCameraPose) return;
    this.#appliedCameraPose = signature;

    const view = runtime.getViewState();
    const camera: CameraView = {
      position: [...view.camera.position] as [number, number, number],
      target: [...view.camera.target] as [number, number, number],
      fov: view.camera.fov,
    };
    const targetValue = parseVector3(targetRaw);
    const target = targetValue ?? camera.target;
    const current = orbitFromCamera(camera.position, camera.target);

    const tokens = (orbitRaw ?? "").trim().split(/\s+/);
    const theta = orbitRaw === null ? undefined : parseOrbitToken(tokens[0], "theta");
    const phi = orbitRaw === null ? undefined : parseOrbitToken(tokens[1], "phi");
    const radius = orbitRaw === null ? undefined : parseOrbitToken(tokens[2], "radius");
    const targetGiven = targetValue !== null;

    if (theta !== undefined || phi !== undefined || radius !== undefined) {
      // Nothing framed yet (an empty scene): assume the reference's default
      // front view rather than inventing `NaN`s.
      const base = current ?? { theta: 0, phi: 75, radius: 1 };
      camera.position = cameraFromOrbit(target, {
        theta: theta ?? base.theta,
        phi: phi ?? base.phi,
        radius: radius ?? base.radius,
      });
      camera.target = target;
    } else if (targetGiven) {
      // Target alone: keep the angles, translate the eye with it.
      if (current) camera.position = cameraFromOrbit(target, current);
      camera.target = target;
    }

    const fov = parseAngle(fovRaw ?? undefined);
    if (fov !== undefined) camera.fov = this.clampFieldOfView(fov);

    // A post-load re-assert (`force` is false) is the *initial* placement: it
    // snaps. An attribute the host changed afterwards is a user intent, so it
    // fades — that is what model-viewer does with `camera-orbit`.
    this.commitCamera(view, camera, !force);
  }

  /**
   * Hand a pose to the runtime.
   *
   * model-viewer interpolates any change to `camera-orbit` / `camera-target`
   * (asymptotically, over `interpolation-decay`), but the initial placement
   * after a load snaps: fading in from wherever the camera happened to be would
   * look like an accidental animation on page load.
   *
   * The fade path deliberately does *not* go through `applyViewState`: an eased
   * pose is presentation only, and must not look like a user view change that
   * gets persisted into the document.
   *
   * Public because the imperative camera API (`setCameraOrbit`,
   * `setCameraTarget`, `setFieldOfView`) shares the same two policies.
   */
  commitCamera(view: ViewState, camera: CameraView, instant: boolean): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;
    if (!instant && runtime.smoothViewTo) {
      runtime.smoothViewTo(camera, this.#interpolationDecay);
      return;
    }
    runtime.applyViewState({ ...view, camera });
  }

  /**
   * `interpolation-decay` (ms, model-viewer default 50): how long a camera move
   * takes. Larger = slower; the decay is asymptotic, so most of the motion
   * happens inside this window.
   */
  get #interpolationDecay(): number {
    const raw = Number.parseFloat(this.#attr("interpolation-decay") ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERPOLATION_DECAY;
  }

  /** `min-field-of-view` / `max-field-of-view`; absent on either side = no clamp. */
  clampFieldOfView(value: number): number {
    const min = readNumberAttr(this.#host.element, "min-field-of-view", 0);
    const max = readNumberAttr(this.#host.element, "max-field-of-view", 0);
    const lower = min > 0 ? min : 0;
    const upper = max > 0 ? max : Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(value, lower), upper);
    return Number.isFinite(clamped) && clamped > 0 ? clamped : value;
  }

  /** `camera-name` as declared, or `null` (the orbit view is in charge). */
  #cameraName(): string | null {
    const raw = this.#attr("camera-name");
    return raw === null || raw.trim() === "" ? null : raw.trim();
  }

  /**
   * `camera-name` — look through a camera authored inside the asset.
   *
   * Display-only and re-asserted after every load, like `variant-name`: camera
   * names only exist once the asset parses, and a document's own `view` would
   * otherwise win the race and leave the attribute ignored.
   */
  #applyCameraName(): void {
    const runtime = this.#host.runtime();
    if (!runtime?.setCameraByName) return;
    const name = this.#cameraName();
    // `null` only clears an active camera; it must not reset a restored view.
    if (name === null && runtime.cameraName === null) return;
    runtime.setCameraByName(name);
  }

  /**
   * `variant-name` — a `KHR_materials_variants` pick (model-viewer parity).
   *
   * Display-only: the choice describes how to look at the asset, not what the
   * document contains, so it never reaches the document. Like the shadow knobs it
   * re-runs after every load — variants are only known once the asset parses, and
   * a name set beforehand has to be applied retroactively.
   */
  #applyVariantName(): void {
    const runtime = this.#host.runtime();
    if (!runtime?.setVariant) return;
    const raw = this.#attr("variant-name");
    const name = raw === null || raw.trim() === "" ? null : raw.trim();
    runtime.setVariant(name);
  }

  /**
   * `shadow-intensity` / `shadow-softness` — model-viewer's contact shadow knobs.
   *
   * Display-only, so it patches the *runtime* view (`applyViewState` never
   * touches the document). It has to re-run after every load: a document's own
   * `view.environment` wins over whatever was applied before it, which is
   * exactly how the promo page's shadow used to disappear the moment the GLB
   * finished loading.
   */
  #applyShadowSettings(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;
    const intensityAttr = this.#attr("shadow-intensity");
    const softnessAttr = this.#attr("shadow-softness");
    if (intensityAttr === null && softnessAttr === null) return;

    const intensity = clamp01(intensityAttr === null ? 1 : Number(intensityAttr));
    const view = runtime.getViewState();
    const environment = { ...view.environment };
    if (intensity <= 0) {
      delete environment.contactShadow;
    } else {
      const softness = Number(softnessAttr ?? 1);
      environment.contactShadow = {
        enabled: true,
        // Straight through: the shadow rig applies the reference's own
        // softness-dependent easing, so a flat fudge factor here would darken
        // the comparison twice.
        opacity: intensity,
        ...(Number.isFinite(softness) ? { softness: clamp01(softness) } : {}),
      };
    }
    runtime.applyViewState({ ...view, environment });
  }

  /**
   * Camera policy: pointer verbs, orbit limits and the turntable. Presentation
   * only — never recorded in the document, so it cannot mark the scene dirty.
   */
  applyCameraSettings(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;

    const el = this.#host.element;
    const limits = readOrbitLimits(el);
    const damping = readDamping(el);
    // `orbit-sensitivity` follows model-viewer: any finite number, negatives
    // invert the drag. A garbage value falls back to 1 rather than freezing.
    const sensitivity = readNumberAttr(el, "orbit-sensitivity", 1);
    // Same contract for the other two verbs — `zoom-sensitivity="0"` freezes
    // the wheel while the drag still orbits.
    const zoomSensitivity = readNumberAttr(el, "zoom-sensitivity", 1);
    const panSensitivity = readNumberAttr(el, "pan-sensitivity", 1);
    runtime.setCameraControls?.({
      pan: !el.hasAttribute("disable-pan"),
      zoom: !el.hasAttribute("disable-zoom"),
      ...(limits === undefined ? {} : { limits }),
      ...(damping === undefined ? {} : { damping }),
      ...(Number.isFinite(sensitivity) ? { sensitivity } : {}),
      ...(Number.isFinite(zoomSensitivity) ? { zoomSensitivity } : {}),
      ...(Number.isFinite(panSensitivity) ? { panSensitivity } : {}),
    });

    runtime.setAutoRotate?.(
      el.hasAttribute("auto-rotate")
        ? {
            enabled: true,
            degreesPerSecond: readNumberAttr(el, "rotation-per-second", 30),
            delayMs: readNumberAttr(el, "auto-rotate-delay", 3000),
          }
        : null,
    );
  }

  /**
   * `touch-action`: mostly DOM. The browser decides whether a drag becomes a
   * page scroll *before* any pointer event reaches us, so there is nothing for
   * the runtime to compute — which is why model-viewer uses this attribute
   * instead of a CSS rule (`touch-action` on the canvas is unreliable on iOS).
   *
   * It still goes through the runtime as well: `OrbitControls` **and**
   * `TransformControls` write `touch-action: none` onto the canvas when they
   * connect, both from async imports whose order is not ours, so a value applied
   * before an addon mounts is silently overwritten. The runtime holds the value
   * against them (see `viewer/touch-action-owner.ts`); this DOM write is what
   * makes the attribute work even before a runtime exists.
   */
  applyTouchAction(): void {
    const raw = (this.#attr("touch-action") ?? "").trim().toLowerCase();
    const value = TOUCH_ACTION_KEYWORDS.has(raw) ? raw : DEFAULT_TOUCH_ACTION;
    const canvas = this.#host.canvas();
    if (canvas) canvas.style.touchAction = value;
    this.#host.runtime()?.setTouchAction?.(value);
  }

  /** Playback transport (autoplay / clip name / crossfade / one-shot). */
  applyPlaybackSettings(): void {
    const runtime = this.#host.runtime();
    if (!runtime) return;

    runtime.setAnimationOptions?.({
      // `pause()` before the content arrives must survive the load: the host
      // asked for a still frame, not for autoplay to win the race.
      autoplay: this.#host.element.hasAttribute("autoplay") && !this.#host.explicitPause(),
      clipName: this.#attr("animation-name"),
      crossfadeSeconds:
        readNumberAttr(this.#host.element, "animation-crossfade-duration", 0) / 1000,
      pauseAtEnd: this.#host.element.hasAttribute("pause-at-end"),
    });
  }

  /**
   * Replay everything that was declared before the runtime existed, in the order
   * connect-time assembly used to apply it. Attributes set before upgrade land
   * here: `observedAttributes` fires during upgrade, but the runtime only exists
   * now.
   */
  applyInitial(): void {
    this.applyDisplaySettings();
    this.applyCameraSettings();
    this.applyPlaybackSettings();
    // The factory already got the preset, but the URL override and the skybox
    // only exist as attributes — nothing else applies them.
    this.applyEnvironmentPreset();
    // Again now that a runtime exists: the canvas alone is not enough, the
    // orbit addon overwrites `touch-action` when it mounts.
    this.applyTouchAction();
  }
}
