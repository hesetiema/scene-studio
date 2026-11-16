import type { SceneEditorElement } from "@scenio/scene-editor/element";
import {
  LIGHTING_PRESETS,
  type LightingPreset,
  type LightingPresetId,
  type ViewState,
} from "@scenio/scene-editor";

/**
 * Studio lighting presets come from the SDK (typed against the document's
 * `view.lights`); this module only owns the studio's application policy.
 */

export { LIGHTING_PRESETS };
export type { LightingPreset, LightingPresetId };

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
