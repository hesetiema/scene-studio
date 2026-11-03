import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";

export type LightingPresetId = "studio" | "cyber" | "sunset" | "contrast";

export interface LightingPreset {
  label: string;
  ambient: ViewState["lights"]["ambient"];
  directional: ViewState["lights"]["directional"];
}

/** Studio lighting presets, kept next to the document `view.lights` shape (D22). */
export const LIGHTING_PRESETS: Record<LightingPresetId, LightingPreset> = {
  studio: {
    label: "Studio",
    ambient: { color: "#ffffff", intensity: 0.65 },
    directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
  },
  cyber: {
    label: "Cyber",
    ambient: { color: "#0a2233", intensity: 0.6 },
    directional: { color: "#38e2ff", intensity: 1.8, position: [6, 8, 5] },
  },
  sunset: {
    label: "Sunset",
    ambient: { color: "#2d1a0e", intensity: 0.5 },
    directional: { color: "#ff9d42", intensity: 1.6, position: [-8, 6, 7] },
  },
  contrast: {
    label: "Noir",
    ambient: { color: "#0c0d10", intensity: 0.25 },
    directional: { color: "#ffffff", intensity: 2.2, position: [0, 12, 4] },
  },
};

export const DEFAULT_BACKDROP = "#0c0e12";

/**
 * Environment presets. Every change goes through `setViewState()` — the document
 * is the single source of truth for camera/lights/background (D22), so presets
 * survive save + reload instead of living only in DOM styles.
 */
export class ScenePresetController {
  readonly #el: SceneEditorElement;

  #lighting: LightingPresetId = "studio";
  #backdrop: string = DEFAULT_BACKDROP;

  constructor(el: SceneEditorElement) {
    this.#el = el;
  }

  get lighting(): LightingPresetId {
    return this.#lighting;
  }

  get backdrop(): string {
    return this.#backdrop;
  }

  applyLighting(id: LightingPresetId): void {
    const preset = LIGHTING_PRESETS[id];
    this.#lighting = id;
    const view = this.#view();
    if (view) {
      this.#el.setViewState({
        ...view,
        lights: {
          ambient: { ...preset.ambient },
          directional: { ...preset.directional, position: [...preset.directional.position] },
        },
      });
    }
    this.syncUI();
  }

  applyBackdrop(hex: string): void {
    this.#backdrop = hex;
    const view = this.#view();
    if (view) {
      this.#el.setViewState({
        ...view,
        environment: { ...view.environment, background: hex },
      });
    }
    this.syncUI();
  }

  /** Returns the new grid visibility. */
  toggleGrid(): boolean {
    const view = this.#view();
    if (!view) return true;
    const nextVisible = !view.environment.gridVisible;
    this.#el.setViewState({
      ...view,
      environment: { ...view.environment, gridVisible: nextVisible },
    });
    this.syncUI();
    return nextVisible;
  }

  gridVisible(): boolean {
    return this.#view()?.environment.gridVisible ?? true;
  }

  /** Live view, or null before the first document is loaded (element boot). */
  #view(): ViewState | null {
    try {
      return this.#el.getViewState();
    } catch {
      return null;
    }
  }

  syncUI(): void {
    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.light === this.#lighting);
    });
    document.querySelectorAll<HTMLElement>(".bg-preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.bg === this.#backdrop);
    });

    const gridBtn = document.querySelector<HTMLElement>("#toggle-grid");
    if (gridBtn) {
      const visible = this.gridVisible();
      gridBtn.classList.toggle("active", visible);
      gridBtn.textContent = visible ? "Floor Grid: ON" : "Floor Grid: OFF";
    }
  }
}
