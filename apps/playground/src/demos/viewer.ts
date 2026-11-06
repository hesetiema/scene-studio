/**
 * Demo: viewer parity with `<model-viewer>`.
 *
 * Everything on this page is driven through the *element attribute* surface —
 * `src`, `loading`, `auto-rotate`, `min/max-camera-orbit`, `disable-*`,
 * `autoplay`, `animation-name`, `animation-crossfade-duration`, `pause-at-end`,
 * `tone-mapping`, `exposure` — plus `setViewState()` for the two view-level
 * switches (background alpha, contact shadow). Nothing here touches the
 * document, which is the point: viewer chrome must never dirty a scene.
 *
 * Two deliberate extras:
 *   - a checkerboard behind the viewport, so the transparent canvas is visible;
 *   - an off-screen `loading="lazy"` probe, because the main viewport is always
 *     visible and could never demonstrate deferral honestly.
 */
import {
  defineSceneEditor,
  type SceneEditorElement,
} from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import type { ViewState } from "@scenio/scene-editor";
import { createLog, q, qa, setFields } from "./shared";

type ModelId = "fox" | "helmet" | "truck";
type LimitsPreset = "free" | "horizontal" | "eye";
type AttrToggle =
  | "auto-rotate"
  | "disable-pan"
  | "disable-zoom"
  | "disable-tap"
  | "autoplay"
  | "pause-at-end";

export interface ViewerDemoState {
  src: string;
  loading: string;
  loaded: boolean;
  clips: string[];
  clipName: string | null;
  autoplay: boolean;
  playing: boolean;
  crossfadeMs: number;
  pauseAtEnd: boolean;
  autoRotate: boolean;
  rotationPerSecond: number;
  limits: LimitsPreset;
  disabled: { pan: boolean; zoom: boolean; tap: boolean };
  background: string | null;
  gridVisible: boolean;
  contactShadow: boolean;
  cameraChanges: number;
  environmentChanges: number;
  modelVisible: boolean | null;
  probeLoaded: boolean;
}

interface ViewerDemoHook {
  state: () => ViewerDemoState;
  actions: {
    setModel: (id: ModelId) => void;
    setLimits: (preset: LimitsPreset) => void;
    setLoading: (mode: "eager" | "lazy") => void;
    toggle: (id: AttrToggle, on: boolean) => void;
    setTransparent: (on: boolean) => void;
    setGrid: (on: boolean) => void;
    setContactShadow: (on: boolean) => void;
    setSpeed: (degreesPerSecond: number) => void;
    setDelay: (ms: number) => void;
    setClip: (name: string) => void;
    setCrossfade: (ms: number) => void;
    setToneMapping: (mode: string) => void;
    setExposure: (value: number) => void;
    resetCamera: () => void;
    scrollToProbe: () => void;
  };
}

declare global {
  interface Window {
    /** Distinct from the studio's `__viewer` (ViewerController) on the main page. */
    __viewerDemo: ViewerDemoHook;
  }
}

const MODELS: Record<ModelId, string> = {
  fox: "/assets/Fox.glb",
  helmet: "/assets/DamagedHelmet.glb",
  truck: "/assets/CesiumMilkTruck.glb",
};

/** model-viewer syntax: `auto` leaves an axis unlimited. */
const LIMIT_ATTRS: Record<Exclude<LimitsPreset, "free">, Array<[string, string]>> = {
  horizontal: [
    ["min-camera-orbit", "-45deg auto auto"],
    ["max-camera-orbit", "45deg auto auto"],
  ],
  eye: [
    ["min-camera-orbit", "auto 60deg 1m"],
    ["max-camera-orbit", "auto 90deg 20m"],
  ],
};

const OPAQUE_BACKGROUND = "#101624";

const log = createLog();
const statusEl = q("#status");
const srcPill = q("#src-pill");
const clipSelect = q<HTMLSelectElement>("#clip-name");
const probeStatus = q("#probe-status");

let editor: SceneEditorElement | null = null;
let loaded = false;
let probeLoaded = false;
let modelVisible: boolean | null = null;
let cameraChanges = 0;
let environmentChanges = 0;
let limits: LimitsPreset = "free";
let crossfadeMs = 0;
/** Remembered UI intent; re-applied after every `src` switch (the doc resets the view). */
let transparent = true;
let gridVisible = false;
let contactShadow = false;

function three(): ThreeRuntime | null {
  return editor ? (editor.runtime as ThreeRuntime) : null;
}

/** View-level switches go through the document view so `environment-change` fires. */
function applyEnvironment(mutate: (env: ViewState["environment"]) => void): void {
  const rt = three();
  if (!editor || !rt) return;
  // Read the live camera first: `applyViewState` re-applies the whole view.
  const view = rt.getViewState();
  const environment = { ...view.environment };
  mutate(environment);
  editor.setViewState({ ...view, environment });
}

function syncEnvironmentSwitches(): void {
  transparent = q<HTMLInputElement>("#transparent").checked;
  gridVisible = q<HTMLInputElement>("#grid").checked;
  contactShadow = q<HTMLInputElement>("#contact-shadow").checked;
  applyEnvironment((environment) => {
    environment.background = transparent ? null : OPAQUE_BACKGROUND;
    environment.gridVisible = gridVisible;
    // `undefined` (not a disabled DTO) means "this view never declared shadows".
    if (contactShadow) environment.contactShadow = { enabled: true };
    else delete environment.contactShadow;
  });
}

function renderStatus(): void {
  const rt = three();
  if (!rt) return;
  setFields(statusEl, [
    ["src", editor?.src?.split("/").pop() ?? "-"],
    ["loaded", loaded],
    ["clips", rt.animations.length],
    ["playing", rt.animationPlaying],
    ["camera-changes", cameraChanges],
    ["env-changes", environmentChanges],
    ["visible", modelVisible ?? "-"],
    ["probe", probeLoaded ? "loaded" : "idle"],
    ["limits", limits],
  ]);
  srcPill.textContent = editor?.src?.split("/").pop() ?? "src";
  probeStatus.textContent = probeLoaded ? "probe: 已加载 ✓" : "probe: 未加载（滚动进入视口才会加载）";
}

function populateClips(names: readonly string[]): void {
  const current = editor?.getAttribute("animation-name") ?? "";
  clipSelect.replaceChildren(
    ...["", ...names].map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "" ? "（自动：首条）" : name;
      return option;
    }),
  );
  clipSelect.value = names.includes(current) ? current : "";
  // A model without clips must not keep a stale name from the previous one.
  if (names.length === 0) editor?.removeAttribute("animation-name");
}

function setModel(id: ModelId): void {
  if (!editor) return;
  loaded = false;
  log(`src = ${MODELS[id]}`);
  editor.src = MODELS[id];
  renderStatus();
}

function setLimits(preset: LimitsPreset): void {
  if (!editor) return;
  limits = preset;
  for (const name of ["min-camera-orbit", "max-camera-orbit"]) editor.removeAttribute(name);
  for (const [name, value] of LIMIT_ATTRS[preset as Exclude<LimitsPreset, "free">] ?? []) {
    editor.setAttribute(name, value);
  }
  log(`orbit limits = ${preset}`);
  renderStatus();
}

function setToggle(id: AttrToggle, on: boolean): void {
  editor?.toggleAttribute(id, on);
}

async function onLoaded(): Promise<void> {
  const rt = three();
  if (!editor || !rt) return;
  loaded = true;

  // The synthesized preview view is the engine default (grid on, opaque off);
  // re-apply whatever the panel currently says.
  syncEnvironmentSwitches();

  const names = rt.animations.map((clip) => clip.name);
  if (!editor.hasAttribute("animation-name") && names[0]) {
    // `animation-name` participates in autoplay: setting it starts the clip.
    editor.setAttribute("animation-name", names[0]);
  }
  // After the attribute, so the select shows the clip that is actually playing.
  populateClips(names);

  renderStatus();
  log.ok(`loaded · clips=${names.length ? names.join(" / ") : "none"}`);
}

function wireEvents(el: SceneEditorElement): void {
  el.addEventListener("load", () => {
    // `load` fires before the preview frames the model; defer one frame so the
    // environment re-apply keeps the fitted camera.
    requestAnimationFrame(() => void onLoaded());
  });
  el.addEventListener("progress", (event) => {
    const detail = (event as CustomEvent<{ totalProgress: number }>).detail;
    if (detail.totalProgress >= 1) log(`progress ${Math.round(detail.totalProgress * 100)}%`);
  });
  el.addEventListener("error", (event) => {
    const detail = (event as CustomEvent<{ code: string; message: string }>).detail;
    log.err(`[${detail.code}] ${detail.message}`);
  });
  el.addEventListener("camera-change", () => {
    cameraChanges += 1;
  });
  el.addEventListener("environment-change", (event) => {
    const detail = (event as CustomEvent<{ source: string }>).detail;
    environmentChanges += 1;
    log(`environment-change · source=${detail.source}`);
    renderStatus();
  });
  el.addEventListener("model-visibility", (event) => {
    modelVisible = (event as CustomEvent<{ visible: boolean }>).detail.visible;
    log(`model-visibility visible=${modelVisible}`);
    renderStatus();
  });
}

function mountProbe(): void {
  const probe = document.createElement("scene-editor") as SceneEditorElement;
  probe.setAttribute("src", "/assets/tri.glb");
  probe.setAttribute("loading", "lazy");
  probe.addEventListener("load", () => {
    probeLoaded = true;
    log.ok("lazy 探针进入视口 → 触发加载");
    renderStatus();
  });
  q("#probe-slot").appendChild(probe);
}

function bindUi(el: SceneEditorElement): void {
  for (const button of qa<HTMLButtonElement>("[data-model]")) {
    button.addEventListener("click", () => setModel(button.dataset.model as ModelId));
  }

  for (const radio of qa<HTMLInputElement>('input[name="loading"]')) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      el.setAttribute("loading", radio.value);
      log(`loading = ${radio.value}`);
    });
  }

  q<HTMLInputElement>("#auto-rotate").addEventListener("change", (event) => {
    setToggle("auto-rotate", (event.target as HTMLInputElement).checked);
    renderStatus();
  });
  q<HTMLInputElement>("#rotation-per-second").addEventListener("input", (event) => {
    el.setAttribute("rotation-per-second", (event.target as HTMLInputElement).value);
  });
  q<HTMLInputElement>("#auto-rotate-delay").addEventListener("input", (event) => {
    el.setAttribute("auto-rotate-delay", (event.target as HTMLInputElement).value);
  });

  q<HTMLSelectElement>("#limits").addEventListener("change", (event) => {
    setLimits((event.target as HTMLSelectElement).value as LimitsPreset);
  });

  for (const id of ["disable-pan", "disable-zoom", "disable-tap"] as const) {
    q<HTMLInputElement>(`#${id}`).addEventListener("change", (event) => {
      setToggle(id, (event.target as HTMLInputElement).checked);
    });
  }
  q("#reset-camera").addEventListener("click", () => el.frameModel());

  q<HTMLInputElement>("#autoplay").addEventListener("change", (event) => {
    setToggle("autoplay", (event.target as HTMLInputElement).checked);
  });
  q<HTMLInputElement>("#pause-at-end").addEventListener("change", (event) => {
    setToggle("pause-at-end", (event.target as HTMLInputElement).checked);
  });
  clipSelect.addEventListener("change", () => {
    if (clipSelect.value) el.setAttribute("animation-name", clipSelect.value);
    else el.removeAttribute("animation-name");
  });
  q<HTMLInputElement>("#crossfade").addEventListener("input", (event) => {
    crossfadeMs = Number((event.target as HTMLInputElement).value);
    el.setAttribute("animation-crossfade-duration", String(crossfadeMs));
  });

  q<HTMLSelectElement>("#tone-mapping").addEventListener("change", (event) => {
    el.setAttribute("tone-mapping", (event.target as HTMLSelectElement).value);
  });
  q<HTMLInputElement>("#exposure").addEventListener("input", (event) => {
    el.setAttribute("exposure", (event.target as HTMLInputElement).value);
  });

  q<HTMLInputElement>("#transparent").addEventListener("change", () => syncEnvironmentSwitches());
  q<HTMLInputElement>("#grid").addEventListener("change", () => syncEnvironmentSwitches());
  q<HTMLInputElement>("#contact-shadow").addEventListener("change", () => syncEnvironmentSwitches());

  q("#clear-log").addEventListener("click", () => q("#log").replaceChildren());
}

function snapshot(): ViewerDemoState {
  const rt = three();
  const view = rt?.getViewState();
  return {
    src: editor?.src ?? "",
    loading: editor?.getAttribute("loading") ?? "eager",
    loaded,
    clips: rt?.animations.map((clip) => clip.name) ?? [],
    clipName: editor?.getAttribute("animation-name") ?? null,
    autoplay: editor?.hasAttribute("autoplay") ?? false,
    playing: rt?.animationPlaying ?? false,
    crossfadeMs,
    pauseAtEnd: editor?.hasAttribute("pause-at-end") ?? false,
    autoRotate: editor?.hasAttribute("auto-rotate") ?? false,
    rotationPerSecond: Number(editor?.getAttribute("rotation-per-second") ?? 30),
    limits,
    disabled: {
      pan: editor?.hasAttribute("disable-pan") ?? false,
      zoom: editor?.hasAttribute("disable-zoom") ?? false,
      tap: editor?.hasAttribute("disable-tap") ?? false,
    },
    background: view?.environment.background ?? null,
    gridVisible: view?.environment.gridVisible ?? false,
    contactShadow: view?.environment.contactShadow?.enabled ?? false,
    cameraChanges,
    environmentChanges,
    modelVisible,
    probeLoaded,
  };
}

async function main(): Promise<void> {
  defineSceneEditor();

  const el = document.createElement("scene-editor") as SceneEditorElement;
  el.style.width = "100%";
  el.style.height = "100%";
  // Declarative preview: exactly what a model-viewer integration writes.
  el.setAttribute("src", MODELS.fox);
  el.setAttribute("autoplay", "");
  el.setAttribute("animation-crossfade-duration", "0");
  el.setAttribute("tone-mapping", "aces");
  q("#stage").appendChild(el);
  editor = el;
  wireEvents(el);
  await el.ready;

  bindUi(el);
  mountProbe();

  window.__viewerDemo = {
    state: snapshot,
    actions: {
      setModel,
      setLimits,
      setLoading: (mode) => el.setAttribute("loading", mode),
      toggle: setToggle,
      setTransparent: (on) => {
        q<HTMLInputElement>("#transparent").checked = on;
        syncEnvironmentSwitches();
      },
      setGrid: (on) => {
        q<HTMLInputElement>("#grid").checked = on;
        syncEnvironmentSwitches();
      },
      setContactShadow: (on) => {
        q<HTMLInputElement>("#contact-shadow").checked = on;
        syncEnvironmentSwitches();
      },
      setSpeed: (degreesPerSecond) => {
        el.setAttribute("rotation-per-second", String(degreesPerSecond));
      },
      setDelay: (ms) => {
        el.setAttribute("auto-rotate-delay", String(ms));
      },
      setClip: (name) => {
        if (name) el.setAttribute("animation-name", name);
        else el.removeAttribute("animation-name");
      },
      setCrossfade: (ms) => {
        crossfadeMs = ms;
        el.setAttribute("animation-crossfade-duration", String(ms));
      },
      setToneMapping: (mode) => el.setAttribute("tone-mapping", mode),
      setExposure: (value) => el.setAttribute("exposure", String(value)),
      resetCamera: () => el.frameModel(),
      scrollToProbe: () => q("#probe-slot").scrollIntoView({ block: "center" }),
    },
  };

  // The auto-rotate loop bumps the counter every rendered frame; paint it at a
  // human cadence instead of 60 times a second.
  setInterval(renderStatus, 400);

  document.body.dataset.demo = "ready";
  renderStatus();
  log.ok("ready · 先试 auto-rotate，再看底部离屏 lazy 探针");
}

void main().catch((error: unknown) => {
  statusEl.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  log.err(`fatal: ${String(error)}`);
});
