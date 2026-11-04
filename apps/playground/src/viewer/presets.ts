import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { LightingPresetId } from "./viewer-state";

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

/** Live view, or null before the first document is loaded (element boot). */
export function readDocumentView(el: SceneEditorElement): ViewState | null {
  try {
    return el.getViewState();
  } catch {
    return null;
  }
}

/**
 * Preset application helpers. Every persisted change goes through
 * `setViewState()`, so the document stays the single source of truth (D22)
 * and presets survive save + reload instead of living in DOM styles.
 */
export function applyLightingPreset(el: SceneEditorElement, id: LightingPresetId): boolean {
  const view = readDocumentView(el);
  if (!view) return false;
  const preset = LIGHTING_PRESETS[id];
  el.setViewState({
    ...view,
    lights: {
      ambient: { ...preset.ambient },
      directional: { ...preset.directional, position: [...preset.directional.position] },
    },
  });
  return true;
}

export function applyBackdrop(el: SceneEditorElement, hex: string): boolean {
  const view = readDocumentView(el);
  if (!view || view.environment.background === hex) return false;
  el.setViewState({ ...view, environment: { ...view.environment, background: hex } });
  return true;
}

/** IBL 强度属于 `view.environment`：持久化，但和背景色一样不进撤销栈。 */
export function applyIblIntensity(el: SceneEditorElement, intensity: number): boolean {
  const view = readDocumentView(el);
  if (!view) return false;
  const next = Number.isFinite(intensity) ? Math.max(0, intensity) : 1;
  if ((view.environment.iblIntensity ?? 1) === next) return false;
  el.setViewState({
    ...view,
    environment: { ...view.environment, iblIntensity: next },
  });
  return true;
}

export function setGridVisible(el: SceneEditorElement, visible: boolean): boolean {
  const view = readDocumentView(el);
  if (!view || view.environment.gridVisible === visible) return false;
  el.setViewState({ ...view, environment: { ...view.environment, gridVisible: visible } });
  return true;
}
