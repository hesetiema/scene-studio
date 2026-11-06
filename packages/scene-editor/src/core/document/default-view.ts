import type { ViewState } from "./schema";

/** Engine defaults (three-runtime initial state) — the canonical view of a new scene. */
export const DEFAULT_VIEW_STATE: ViewState = {
  camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
  lights: {
    ambient: { color: "#ffffff", intensity: 0.55 },
    directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
  },
  environment: { background: null, gridVisible: true, iblIntensity: 1 },
};

/** Engine defaults (three-runtime initial state) — the canonical view of a new scene. */
export function createDefaultViewState(): ViewState {
  return structuredClone(DEFAULT_VIEW_STATE);
}

/**
 * model-viewer's `field-of-view="auto"` in landscape panes. Portrait viewports
 * use 45° instead; `frameViewer()` re-derives it from the aspect at frame time,
 * so this is only the initial value the synthesized document carries.
 */
export const PREVIEW_FOV = 30;

/**
 * Viewer defaults for the declarative preview path (`<scene-editor src>`).
 *
 * Deliberately *not* the editor defaults above — a viewer is not an editor:
 * - `gridVisible: false` — the floor grid is authoring chrome; model-viewer has none.
 * - `fov: 45` — model-viewer's default vertical FOV, so framing matches.
 * - lights at `0` — the environment map is the only light source, the way
 *   model-viewer renders. The analytic ambient + key light would add a second,
 *   flatter light on top of the IBL and wash out its contrast.
 */
export const PREVIEW_VIEW_STATE: ViewState = {
  // Replaced by `autoFrame()` right after load; a sane default keeps
  // `getViewState()` meaningful if framing is skipped.
  camera: { position: [0, 0, 10], target: [0, 0, 0], fov: PREVIEW_FOV },
  lights: {
    ambient: { color: "#ffffff", intensity: 0 },
    directional: { color: "#ffffff", intensity: 0, position: [5, 10, 7] },
  },
  environment: { background: null, gridVisible: false, iblIntensity: 1 },
};

/** Detached copy of {@link PREVIEW_VIEW_STATE}. */
export function createPreviewViewState(): ViewState {
  return structuredClone(PREVIEW_VIEW_STATE);
}
