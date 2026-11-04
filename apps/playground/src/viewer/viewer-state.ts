/**
 * Single viewer state (reference: three-gltf-viewer's `Viewer#state`).
 *
 * Panels never touch the runtime directly for view concerns — they patch this
 * store, and `ViewerController` translates a changed slice into exactly one
 * `update*()` call. Document-owned values (background, grid, lights) still go
 * back through `SceneEditorElement.setViewState()` so they persist (D22).
 */

export type DisplayMode = "studio" | "xray" | "wireframe" | "normal" | "clay";
export type LightingPresetId = "studio" | "cyber" | "sunset" | "contrast";
export type ToneMappingId = "none" | "linear" | "aces";

export interface AnimationSelection {
  /** `${objectId}#${index}`, or null when the asset has no clips. */
  clipId: string | null;
  playing: boolean;
  speed: number;
}

export interface ViewerState {
  display: DisplayMode;
  skeleton: boolean;
  grid: boolean;
  background: string;
  lighting: LightingPresetId;
  exposure: number;
  toneMapping: ToneMappingId;
  autoRotate: boolean;
  animation: AnimationSelection;
}

export type ViewerStatePatch = Omit<Partial<ViewerState>, "animation"> & {
  animation?: Partial<AnimationSelection>;
};

export const DEFAULT_VIEWER_STATE: ViewerState = {
  display: "studio",
  skeleton: false,
  grid: true,
  background: "#0c0e12",
  lighting: "studio",
  exposure: 1,
  toneMapping: "none",
  autoRotate: false,
  animation: { clipId: null, playing: false, speed: 1 },
};

export interface ViewerStore {
  readonly state: ViewerState;
  /** Merge a patch; nested `animation` is merged, everything else replaced. */
  patch(patch: ViewerStatePatch): void;
  /** Replace document-owned slices after a load (keeps transient UI choices). */
  syncFromDocument(partial: ViewerStatePatch): void;
  subscribe(listener: (next: ViewerState, prev: ViewerState) => void): () => void;
}

export function createViewerStore(initial: ViewerState = DEFAULT_VIEWER_STATE): ViewerStore {
  let state: ViewerState = {
    ...initial,
    animation: { ...initial.animation },
  };
  const listeners = new Set<(next: ViewerState, prev: ViewerState) => void>();

  const commit = (next: ViewerState): void => {
    const prev = state;
    state = next;
    for (const listener of listeners) listener(next, prev);
  };

  return {
    get state(): ViewerState {
      return state;
    },
    patch(patch: ViewerStatePatch): void {
      const { animation, ...rest } = patch;
      commit({
        ...state,
        ...rest,
        animation: animation ? { ...state.animation, ...animation } : state.animation,
      });
    },
    syncFromDocument(partial: ViewerStatePatch): void {
      commit({
        ...state,
        ...partial,
        animation: partial.animation ? { ...state.animation, ...partial.animation } : state.animation,
      });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
