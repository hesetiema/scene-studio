import type { ViewState } from "./schema";

/** Engine defaults (three-runtime initial state) — the canonical view of a new scene. */
export function createDefaultViewState(): ViewState {
  return {
    camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.55 },
      directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
    },
    environment: { background: null, gridVisible: true },
  };
}
