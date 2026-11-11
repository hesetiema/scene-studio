import type { ViewState } from "../document/schema";

/** One preset's light setup — same shape as `view.lights` minus the extras. */
export interface LightingPreset {
  /** UI label; display only. */
  label: string;
  ambient: ViewState["lights"]["ambient"];
  directional: ViewState["lights"]["directional"];
}

export type LightingPresetId = "studio" | "cyber" | "sunset" | "contrast";

/**
 * Reference lighting presets, typed against the document's `view.lights`.
 *
 * Data, not behaviour: hosts apply them through their own `setViewState` (or
 * `applyViewPatch`), so a preset is a persisted document change like any other
 * light edit. These are starting points, not a registry — a host with its own
 * look defines its own table with the same shape.
 */
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
