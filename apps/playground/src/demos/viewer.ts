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

type ModelId = "fox" | "helmet" | "truck" | "fixture";
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
  cameras: string[];
  cameraName: string | null;
  morphs: Array<{ name: string; influence: number; driven: boolean }>;
  /* viewer transport + declarative pose (0.9.x) */
  availableAnimations: string[];
  paused: boolean;
  currentTime: number;
  duration: number;
  timeScale: number;
  orbit: { theta: number; phi: number; radius: number } | null;
  fov: number;
  alt: string | null;
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
    setCamera: (name: string | null) => void;
    setMorph: (index: number, value: number) => void;
    setDamping: (on: boolean) => void;
    play: () => boolean;
    pause: () => void;
    seek: (seconds: number) => void;
    setTimeScale: (value: number) => void;
    setOrbit: (orbit: { theta?: number; phi?: number; radius?: number }) => void;
    setFieldOfView: (degrees: number) => void;
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
  // Hand-built glTF: two authored cameras + two morph targets.
  fixture: "/assets/camera-morph.gltf",
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
    ["t", `${(editor?.currentTime ?? 0).toFixed(2)}s`],
    ["camera-changes", cameraChanges],
    ["env-changes", environmentChanges],
    ["visible", modelVisible ?? "-"],
    ["probe", probeLoaded ? "loaded" : "idle"],
    ["limits", limits],
    ["camera", rt.cameraName ?? "-"],
  ]);
  srcPill.textContent = editor?.src?.split("/").pop() ?? "src";
  probeStatus.textContent = probeLoaded ? "probe: 已加载 ✓" : "probe: 未加载（滚动进入视口才会加载）";
  renderTransport();
}

/**
 * Transport widgets track the element, not the other way round: the mixer keeps
 * advancing the playhead, so the slider is painted from `currentTime` on the same
 * 400ms cadence as the status line — except while the host is dragging it.
 */
function renderTransport(): void {
  if (!editor) return;
  const rt = three();
  const toggle = q<HTMLButtonElement>("#transport-toggle");
  const paused = editor.paused;
  toggle.textContent = paused ? "播放" : "暂停";

  const seek = q<HTMLInputElement>("#seek");
  const duration = rt?.animationDuration ?? 0;
  seek.max = String(duration || 1);
  seek.disabled = duration <= 0;
  const time = editor.currentTime;
  q("#seek-label").textContent = `${time.toFixed(2)}s / ${duration.toFixed(2)}s`;
  if (document.activeElement !== seek) seek.value = String(Math.min(time, duration || 1));
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

/** Cameras come from the asset, so the dropdown is rebuilt on every load. */
function populateCameras(names: readonly string[]): void {
  const select = q<HTMLSelectElement>("#camera-name");
  const current = editor?.cameraName ?? "";
  select.replaceChildren(
    ...["", ...names].map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "" ? "轨道视角" : name;
      return option;
    }),
  );
  select.value = names.includes(current) ? current : "";
}

/**
 * Morph sliders, rebuilt per load. A channel the playing clip writes is shown
 * disabled instead of silently snapping back: the mixer owns it until playback
 * stops.
 */
function renderMorphs(): void {
  const host = q("#morph-list");
  const targets = editor?.morphTargets ?? [];
  if (targets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "demo-note";
    empty.textContent = "当前模型没有 morph target。";
    host.replaceChildren(empty);
    return;
  }

  host.replaceChildren(
    ...targets.map((target) => {
      const row = document.createElement("label");
      row.className = `demo-morph-row${target.driven ? " is-driven" : ""}`;
      row.title = target.driven ? "动画正在驱动这条通道，暂停后可手动调整" : "";

      const name = document.createElement("span");
      name.textContent = target.name;
      const readout = document.createElement("b");
      readout.textContent = target.influence.toFixed(2);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(target.influence);
      slider.disabled = target.driven;
      slider.addEventListener("input", () => {
        const value = Number(slider.value);
        const applied = editor?.setMorphInfluence(
          target.objectId,
          target.meshIndex,
          target.targetIndex,
          value,
        );
        if (applied) {
          readout.textContent = value.toFixed(2);
          return;
        }
        // Refused: the clip took the channel back, or the asset changed.
        log.err(`morph ${target.name} 被拒绝（动画驱动或通道已失效）`);
        renderMorphs();
      });

      row.append(name, slider, readout);
      return row;
    }),
  );
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
  populateCameras(editor.cameras);
  renderMorphs();
  // `alt` is the canvas' accessible name (model-viewer parity). Recomputed per
  // load so the label follows the model instead of the first one.
  editor.setAttribute("alt", `3D 模型：${editor.src?.split("/").pop() ?? "未命名"}`);
  renderTransport();

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

  q<HTMLSelectElement>("#camera-name").addEventListener("change", (event) => {
    const name = (event.target as HTMLSelectElement).value;
    if (name) el.setAttribute("camera-name", name);
    else el.removeAttribute("camera-name");
    log(`camera-name = ${name || "（轨道视角）"}`);
    renderStatus();
  });
  q<HTMLInputElement>("#camera-damping").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    el.toggleAttribute("camera-damping", on);
    log(`camera-damping = ${on}`);
  });
  q<HTMLInputElement>("#interaction-prompt").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    // The default is `auto`; the checkbox only ever switches it off.
    if (on) el.removeAttribute("interaction-prompt");
    else el.setAttribute("interaction-prompt", "none");
  });

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

  q("#transport-toggle").addEventListener("click", () => {
    if (el.paused) {
      const started = el.play();
      log(started ? "play()" : "play() 无 clip 可播");
    } else {
      el.pause();
      log("pause()");
    }
    renderTransport();
  });
  q<HTMLInputElement>("#time-scale").addEventListener("input", (event) => {
    el.timeScale = Number((event.target as HTMLInputElement).value);
  });
  q<HTMLInputElement>("#seek").addEventListener("input", (event) => {
    el.currentTime = Number((event.target as HTMLInputElement).value);
    renderTransport();
  });

  q<HTMLSelectElement>("#camera-orbit").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    // The camera-name pose outranks the orbit attributes; drop it so the preset
    // is not silently ignored.
    if (value) {
      el.removeAttribute("camera-name");
      el.setAttribute("camera-orbit", value);
      log(`camera-orbit = ${value}`);
    } else {
      el.removeAttribute("camera-orbit");
      log("camera-orbit = （自动取景）");
    }
  });
  q<HTMLInputElement>("#field-of-view").addEventListener("change", (event) => {
    const raw = (event.target as HTMLInputElement).value.trim();
    if (raw === "") {
      el.removeAttribute("field-of-view");
      el.frameModel();
      log("field-of-view = auto");
      return;
    }
    el.setAttribute("field-of-view", `${raw}deg`);
    log(`field-of-view = ${raw}deg`);
  });
  q("#read-orbit").addEventListener("click", () => {
    const orbit = el.getCameraOrbit();
    if (!orbit) {
      log.err("getCameraOrbit() → null（相机贴在 target 上）");
      return;
    }
    const round = (value: number): number => Math.round(value * 10) / 10;
    log(
      `orbit θ=${round(orbit.theta)}° φ=${round(orbit.phi)}° r=${round(orbit.radius)} · fov=${round(
        el.getFieldOfView(),
      )}°`,
    );
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
    cameras: three()?.cameras ?? [],
    cameraName: three()?.cameraName ?? null,
    morphs: (editor?.morphTargets ?? []).map((target) => ({
      name: target.name,
      influence: Number(target.influence.toFixed(3)),
      driven: target.driven,
    })),
    availableAnimations: editor?.availableAnimations ?? [],
    paused: editor?.paused ?? true,
    currentTime: Number((editor?.currentTime ?? 0).toFixed(3)),
    duration: Number((rt?.animationDuration ?? 0).toFixed(3)),
    timeScale: editor?.timeScale ?? 1,
    orbit: editor?.getCameraOrbit() ?? null,
    fov: Number((editor?.getFieldOfView() ?? 0).toFixed(2)),
    alt: editor?.getAttribute("alt") ?? null,
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
      setCamera: (name) => {
        if (name) el.setAttribute("camera-name", name);
        else el.removeAttribute("camera-name");
        q<HTMLSelectElement>("#camera-name").value = name ?? "";
      },
      setMorph: (index, value) => {
        const target = el.morphTargets[index];
        if (target) {
          el.setMorphInfluence(target.objectId, target.meshIndex, target.targetIndex, value);
          renderMorphs();
        }
      },
      setDamping: (on) => {
        el.toggleAttribute("camera-damping", on);
        q<HTMLInputElement>("#camera-damping").checked = on;
      },
      play: () => el.play(),
      pause: () => el.pause(),
      seek: (seconds) => {
        el.currentTime = seconds;
      },
      setTimeScale: (value) => {
        el.timeScale = value;
        q<HTMLInputElement>("#time-scale").value = String(value);
      },
      setOrbit: (orbit) => {
        el.removeAttribute("camera-name");
        el.setCameraOrbit(orbit);
      },
      setFieldOfView: (degrees) => {
        el.setFieldOfView(degrees);
        q<HTMLInputElement>("#field-of-view").value = String(degrees);
      },
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
