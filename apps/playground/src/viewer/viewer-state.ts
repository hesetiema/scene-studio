import { proxy, snapshot } from "valtio/vanilla";

/**
 * Single viewer state (reference: three-gltf-viewer's `Viewer#state`).
 *
 * Panels never touch the runtime directly for view concerns — they patch this
 * store, and `ViewerController` translates a changed slice into exactly one
 * `update*()` call. Document-owned values (background, grid, lights) still go
 * back through `SceneEditorElement.setViewState()` so they persist (D22).
 *
 * The state itself is a valtio proxy (vanilla API): mutations are live, while
 * `snapshot()` gives the immutable copies that make up the undo stack. Coalescing
 * keeps one slider drag as one history entry.
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
  /** IBL 环境光照强度倍率（0 = 关闭，只用灯光），持久化到 `view.environment`。 */
  iblIntensity: number;
  lighting: LightingPresetId;
  /** 环境光强度倍率，1 = 预设原值（UI 显示为百分比）。 */
  ambientScale: number;
  /** 主光强度倍率，1 = 预设原值。 */
  directionalScale: number;
  /** 环境光颜色覆盖；null 表示跟随灯光预设。 */
  ambientColor: string | null;
  /** 主光颜色覆盖；null 表示跟随灯光预设。 */
  directionalColor: string | null;
  /** 主光跟随观察视角（相当于头灯），只影响观看。 */
  followCamera: boolean;
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
  iblIntensity: 1,
  lighting: "studio",
  ambientScale: 1,
  directionalScale: 1,
  ambientColor: null,
  directionalColor: null,
  followCamera: false,
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

  /** 最近一次进入历史的改动时间，用于和文档命令比先后。 */
  readonly lastChangeAt: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): boolean;
  redo(): boolean;
}

const HISTORY_LIMIT = 100;
/** 同一组控件的连续输入（例如拖滑块）合并成一步。 */
const MERGE_WINDOW_MS = 400;
/** 播放/自动环绕是瞬时状态，不参与撤销。 */
const TRANSIENT_KEYS: ReadonlySet<string> = new Set(["animation", "autoRotate"]);

interface HistoryEntry {
  state: ViewerState;
  /** 这次改动发生的时间，用于和文档命令比先后。 */
  at: number;
}

export function createViewerStore(initial: ViewerState = DEFAULT_VIEWER_STATE): ViewerStore {
  const state = proxy<ViewerState>({
    ...initial,
    animation: { ...initial.animation },
  });

  const read = (): ViewerState => snapshot(state) as ViewerState;

  let entries: HistoryEntry[] = [{ state: read(), at: 0 }];
  let index = 0;
  let lastChangeAt = 0;
  let lastRecordAt = 0;
  let lastRecordKey = "";
  const listeners = new Set<(next: ViewerState, prev: ViewerState) => void>();

  const emit = (prev: ViewerState): void => {
    const next = read();
    for (const listener of listeners) listener(next, prev);
  };

  const apply = (from: ViewerState): void => {
    Object.assign(state, from);
    state.animation = { ...from.animation };
  };

  const resetMerge = (): void => {
    lastRecordAt = 0;
    lastRecordKey = "";
  };

  const record = (next: ViewerState, keys: readonly string[]): void => {
    const historyKeys = keys.filter((key) => !TRANSIENT_KEYS.has(key));
    if (historyKeys.length === 0) return;

    const now = performance.now();
    const key = historyKeys.join(",");
    const merging = now - lastRecordAt < MERGE_WINDOW_MS && key === lastRecordKey && index > 0;

    if (merging) {
      entries[index] = { state: next, at: now };
    } else {
      entries = entries.slice(0, index + 1);
      entries.push({ state: next, at: now });
      if (entries.length > HISTORY_LIMIT) entries.shift();
      index = entries.length - 1;
    }

    lastRecordAt = now;
    lastRecordKey = key;
    lastChangeAt = now;
  };

  return {
    get state(): ViewerState {
      return read();
    },
    get lastChangeAt(): number {
      return lastChangeAt;
    },
    get canUndo(): boolean {
      return index > 0;
    },
    get canRedo(): boolean {
      return index < entries.length - 1;
    },
    patch(patch: ViewerStatePatch): void {
      const prev = read();
      const { animation, ...rest } = patch;
      Object.assign(state, rest);
      if (animation) state.animation = { ...state.animation, ...animation };

      record(read(), Object.keys(patch));
      emit(prev);
    },
    syncFromDocument(partial: ViewerStatePatch): void {
      const prev = read();
      const { animation, ...rest } = partial;
      Object.assign(state, rest);
      if (animation) state.animation = { ...state.animation, ...animation };

      // 换文档 = 新的撤销基线：历史回到「当前状态」这一点。
      entries = [{ state: read(), at: 0 }];
      index = 0;
      lastChangeAt = 0;
      resetMerge();
      emit(prev);
    },
    undo(): boolean {
      if (index <= 0) return false;
      const prev = read();
      index -= 1;
      apply((entries[index] as HistoryEntry).state);
      resetMerge();
      // 现在栈顶那一笔改动的时间：下一轮撤销据此和文档命令比先后。
      lastChangeAt = (entries[index] as HistoryEntry).at;
      emit(prev);
      return true;
    },
    redo(): boolean {
      if (index >= entries.length - 1) return false;
      const prev = read();
      index += 1;
      apply((entries[index] as HistoryEntry).state);
      resetMerge();
      lastChangeAt = (entries[index] as HistoryEntry).at;
      emit(prev);
      return true;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
