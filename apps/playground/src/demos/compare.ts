/**
 * Demo: side-by-side `<model-viewer>` vs `<scene-editor>` (promo / eyeball only).
 *
 * Deliberately *not* covered by Playwright: the left pane needs the official
 * `model-viewer` bundle from a CDN, so this page can only render online. The
 * assertions live on `demos/viewer.html`, which uses the same attribute surface
 * against the SDK alone.
 *
 * One toolbar drives both elements at once — the point being that the attribute
 * names are identical; only the per-element niceties differ (`shadow-intensity`
 * vs `contactShadow`, `camera-orbit` vs `min/max-camera-orbit`).
 */
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import { q } from "./shared";

interface ModelViewerLike extends HTMLElement {
  availableAnimations?: string[];
  play?: () => void;
  pause?: () => void;
}

const MODELS: Record<string, string> = {
  fox: "/assets/Fox.glb",
  helmet: "/assets/DamagedHelmet.glb",
  truck: "/assets/CesiumMilkTruck.glb",
};

const mv = q<ModelViewerLike>("#mv");
const clipSelect = q<HTMLSelectElement>("#clip");
const playButton = q<HTMLButtonElement>("#toggle-play");

let editor: SceneEditorElement | null = null;
let paused = false;
let clipName: string | null = null;
/** `model-viewer` upgrades once, possibly long after this module runs. */
let mvBound = false;

function ours(): ThreeRuntime | null {
  return editor ? (editor.runtime as ThreeRuntime) : null;
}

/**
 * Two mirrors, tried in order: a promo page should survive one CDN being slow
 * or blocked. The overlay starts as "loading…" and only becomes a failure hint,
 * so a slow network never looks like a broken page.
 */
const MV_SOURCES = [
  "https://unpkg.com/@google/model-viewer@4/dist/model-viewer.min.js",
  "https://cdn.jsdelivr.net/npm/@google/model-viewer@4/dist/model-viewer.min.js",
];

async function loadModelViewer(): Promise<boolean> {
  const fallback = q("#mv-fallback");
  const isDefined = (): boolean => Boolean(customElements.get("model-viewer"));
  if (isDefined()) {
    fallback.setAttribute("hidden", "");
    return true;
  }

  for (const source of MV_SOURCES) {
    if (isDefined()) break;
    try {
      await import(/* @vite-ignore */ source);
      // The bundle defines the element during module evaluation; one microtask
      // race covers bundles that defer it.
      await Promise.race([
        customElements.whenDefined("model-viewer").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Mirror unreachable → try the next one.
    }
  }

  if (!isDefined()) {
    fallback.textContent =
      "model-viewer CDN 不可用（离线 / 被拦截）。右侧仍可用，本页仅用于目视对照。";
    return false;
  }
  fallback.setAttribute("hidden", "");
  return true;
}

function collectClips(): string[] {
  const fromOurs = ours()?.animations.map((clip) => clip.name) ?? [];
  // model-viewer only exposes this after its `load`; undefined before that.
  const fromViewer = Array.isArray(mv.availableAnimations) ? mv.availableAnimations : [];
  return [...new Set([...fromOurs, ...fromViewer])];
}

function refreshClips(): void {
  const names = collectClips();
  clipSelect.replaceChildren(
    ...["", ...names].map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "" ? "（首条）" : name;
      return option;
    }),
  );
  clipSelect.value = clipName !== null && names.includes(clipName) ? clipName : "";
}

function applyClip(name: string): void {
  clipName = name || null;
  if (name) {
    mv.setAttribute("animation-name", name);
    editor?.setAttribute("animation-name", name);
  } else {
    mv.removeAttribute("animation-name");
    editor?.removeAttribute("animation-name");
  }
}

function setModel(id: string): void {
  const url = MODELS[id];
  if (!url) return;
  mv.setAttribute("src", url);
  if (editor) editor.src = url;
  // Both sides restart on `autoplay`; keep the transport button honest.
  paused = false;
  playButton.textContent = "暂停";
}

function applyShadow(enabled: boolean): void {
  mv.setAttribute("shadow-intensity", enabled ? "1" : "0");
  const rt = ours();
  if (!rt || !editor) return;
  const view = rt.getViewState();
  const environment = { ...view.environment };
  if (enabled) environment.contactShadow = { enabled: true };
  else delete environment.contactShadow;
  // Runtime path: a viewer switch must not mark the document dirty.
  rt.applyViewState({ ...view, environment });
}

function togglePlay(): void {
  const rt = ours();
  if (!rt) return;
  paused = !paused;
  if (paused) {
    mv.pause?.();
    rt.pauseAnimations();
  } else {
    mv.play?.();
    rt.resumeAnimations();
  }
  playButton.textContent = paused ? "播放" : "暂停";
}

function onOursLoaded(): void {
  const names = collectClips();
  if (names.length === 0) {
    clipName = null;
    editor?.removeAttribute("animation-name");
  } else if (clipName === null || !names.includes(clipName)) {
    // `animation-name` also participates in autoplay on the SDK side.
    applyClip(names[0] ?? "");
  }
  refreshClips();
}

function bind(): void {
  q<HTMLSelectElement>("#model").addEventListener("change", (event) => {
    setModel((event.target as HTMLSelectElement).value);
  });
  q<HTMLInputElement>("#autoplay").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    mv.toggleAttribute("autoplay", on);
    editor?.toggleAttribute("autoplay", on);
  });
  q<HTMLInputElement>("#auto-rotate").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    mv.toggleAttribute("auto-rotate", on);
    editor?.toggleAttribute("auto-rotate", on);
  });
  q<HTMLInputElement>("#shadow").addEventListener("change", (event) => {
    applyShadow((event.target as HTMLInputElement).checked);
  });
  q<HTMLInputElement>("#exposure").addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value;
    mv.setAttribute("exposure", value);
    editor?.setAttribute("exposure", value);
  });
  clipSelect.addEventListener("change", () => applyClip(clipSelect.value));
  playButton.addEventListener("click", togglePlay);
}

async function main(): Promise<void> {
  defineSceneEditor();

  const el = document.createElement("scene-editor") as SceneEditorElement;
  el.setAttribute("src", MODELS.fox!);
  el.setAttribute("autoplay", "");
  el.setAttribute("animation-crossfade-duration", "200");
  q("#se-frame").appendChild(el);
  editor = el;
  el.addEventListener("load", onOursLoaded);
  await el.ready;

  bind();
  applyShadow(q<HTMLInputElement>("#shadow").checked);

  // A late CDN arrival still upgrades the left pane: `whenDefined` outlives the
  // timeout that only decides whether to show the failure hint.
  void customElements
    .whenDefined("model-viewer")
    .then(() => {
      q("#mv-fallback").setAttribute("hidden", "");
      if (!mvBound) {
        mvBound = true;
        mv.addEventListener("load", refreshClips);
      }
      refreshClips();
    })
    .catch(() => undefined);

  await loadModelViewer();
}

void main();
