import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ViewerStore } from "./viewer-state";

type Scope = "viewer" | "document" | "camera";

type CameraPose = ViewState["camera"];

interface PoseEntry {
  pose: CameraPose;
  /** 这一笔发生的时间，用于和另外两栈比先后。 */
  at: number;
}

interface HistoryChangeDetail {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  lastCommand?: string;
}

interface ViewChangeDetail {
  view: ViewState;
  /** `load` = 换了文档；`interaction` = 手势结束；`api` = 宿主/面板写入。 */
  source: "interaction" | "api" | "load";
}

/** 真正在录入文本的控件才交还给浏览器；滑块/复选框/取色器上的 Ctrl+Z 仍属撤销。 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

const CAMERA_HISTORY_LIMIT = 100;
/** 同一段连续操作（滚轮连滚、快速两次拖拽）合并成一步。 */
const CAMERA_MERGE_MS = 400;
/** 位姿比较的容差：视角是浮点结果，严格相等会把抖动算成新的一步。 */
const POSE_EPSILON = 1e-6;

/**
 * 统一撤销/重做：面板设置（viewer state，valtio 快照栈）、文档命令（SDK 历史）
 * 与相机位姿（宿主自建栈）共用一对按钮和 Ctrl+Z / Ctrl+Y。
 *
 * 撤销时比较三边最近一次改动的时间：谁更晚先撤谁；重做按撤销顺序回放。
 * 三者各有存在理由：
 * - 视觉设置是预览态，不进文档，必须有自己的栈；
 * - 文档命令由 SDK 管；
 * - 视角在 SDK 里是「持久化但不进命令栈」（D22），而用户按 Ctrl+Z 的直觉是
 *   「我刚转过视角，应该能退回去」，所以宿主替它记一份位姿快照。SDK 侧策略不变：
 *   `setViewState()` 仍然只标脏、不进命令栈，换宿主也不会突然多出可撤销的视角。
 *
 * 视角的采样点只有一个：元素的 `view-change`。它刻意「一次手势只发一次」「飞行结束
 * commit 一次」，所以一次拖拽/一次聚焦就是一步；而方向键与 +/- 走 `setCameraOrbit()
 * → applyViewState()`（不发事件、不标脏），属于查看器侧的临时导航，不进撤销。
 */
export class HistoryCoordinator {
  readonly #el: SceneEditorElement;
  readonly #store: ViewerStore;

  #docCanUndo = false;
  #docCanRedo = false;
  #docEditAt = 0;
  #internal = false;
  #redoOrder: Scope[] = [];
  #unsubscribe: (() => void) | null = null;

  /** 视角栈；`#cameraIndex === 0` 是本次载入的基线。 */
  #poses: PoseEntry[] = [];
  #cameraIndex = 0;
  #cameraReady = false;
  /** 栈顶那一笔的时间，用于和另外两栈比先后。 */
  #cameraAt = 0;
  #cameraRecordAt = 0;

  constructor(el: SceneEditorElement, store: ViewerStore) {
    this.#el = el;
    this.#store = store;

    el.addEventListener("history-change", this.#onHistoryChange);
    el.addEventListener("view-change", this.#onViewChange);
    this.#unsubscribe = store.subscribe(() => {
      // 新的面板改动会截断重做栈，重做顺序也随之失效。
      if (!this.#internal && !this.#store.canRedo) this.#redoOrder = [];
    });
  }

  get canUndo(): boolean {
    return this.#store.canUndo || this.#docCanUndo || this.#cameraIndex > 0;
  }

  get canRedo(): boolean {
    return this.#store.canRedo || this.#docCanRedo || this.#cameraIndex < this.#poses.length - 1;
  }

  undo(): boolean {
    for (const scope of this.#recencyOrder()) {
      if (scope === "viewer" && this.#undoViewer()) return this.#record("viewer");
      if (scope === "document" && this.#undoDocument()) return this.#record("document");
      if (scope === "camera" && this.#undoCamera()) return this.#record("camera");
    }
    return false;
  }

  redo(): boolean {
    while (this.#redoOrder.length > 0) {
      const scope = this.#redoOrder.pop();
      if (scope === "viewer" && this.#redoViewer()) return true;
      if (scope === "document" && this.#redoDocument()) return true;
      if (scope === "camera" && this.#redoCamera()) return true;
    }
    // 撤销顺序丢了（例如重开页面后只剩栈）：按固定优先级兜底。
    return this.#redoViewer() || this.#redoDocument() || this.#redoCamera();
  }

  /**
   * 把当前相机位姿当成新基线。载入文档后的自动取景属于「打开」而不是「编辑」，
   * 不占一步撤销 —— 否则刚打开模型按 Ctrl+Z 会退回载入前的机位。
   */
  resetCameraBaseline(): void {
    const pose = this.#currentPose();
    if (pose) this.#resetCamera(pose);
  }

  destroy(): void {
    this.#el.removeEventListener("history-change", this.#onHistoryChange);
    this.#el.removeEventListener("view-change", this.#onViewChange);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #record(scope: Scope): true {
    this.#redoOrder.push(scope);
    return true;
  }

  /** 三栈按最近改动时间排列；没有可撤项的栈时间为 -1，自然垫底。 */
  #recencyOrder(): Scope[] {
    const ranked: Array<{ scope: Scope; at: number }> = [
      { scope: "viewer", at: this.#store.canUndo ? this.#store.lastChangeAt : -1 },
      { scope: "document", at: this.#docCanUndo && this.#documentEditable() ? this.#docEditAt : -1 },
      { scope: "camera", at: this.#cameraIndex > 0 ? this.#cameraAt : -1 },
    ];
    return ranked.sort((a, b) => b.at - a.at).map((entry) => entry.scope);
  }

  /** 查看态是只读的：文档命令不可撤；观看设置与视角两态都可撤。 */
  #documentEditable(): boolean {
    return this.#el.mode === "editor";
  }

  #undoViewer(): boolean {
    this.#internal = true;
    try {
      return this.#store.undo();
    } finally {
      this.#internal = false;
    }
  }

  #redoViewer(): boolean {
    this.#internal = true;
    try {
      return this.#store.redo();
    } finally {
      this.#internal = false;
    }
  }

  #undoDocument(): boolean {
    if (!this.#docCanUndo || !this.#documentEditable()) return false;
    this.#internal = true;
    try {
      this.#el.undo();
    } finally {
      this.#internal = false;
    }
    return true;
  }

  #redoDocument(): boolean {
    if (!this.#docCanRedo || !this.#documentEditable()) return false;
    this.#internal = true;
    try {
      this.#el.redo();
    } finally {
      this.#internal = false;
    }
    return true;
  }

  #undoCamera(): boolean {
    if (this.#cameraIndex <= 0) return false;
    this.#cameraIndex -= 1;
    const entry = this.#poses[this.#cameraIndex];
    if (!entry) return false;
    this.#applyPose(entry.pose);
    this.#cameraAt = entry.at;
    this.#cameraRecordAt = 0;
    return true;
  }

  #redoCamera(): boolean {
    if (this.#cameraIndex >= this.#poses.length - 1) return false;
    this.#cameraIndex += 1;
    const entry = this.#poses[this.#cameraIndex];
    if (!entry) return false;
    this.#applyPose(entry.pose);
    this.#cameraAt = entry.at;
    this.#cameraRecordAt = 0;
    return true;
  }

  /**
   * 写回一帧位姿。走 `setViewState()` 而不是 runtime：文档里的 `view.camera`
   * 必须跟着改，否则保存后重新打开会跳回旧机位。`#internal` 保证这次写入
   * 不再被 `view-change` 记成新的一笔。
   */
  #applyPose(pose: CameraPose): void {
    this.#internal = true;
    try {
      const view = this.#el.getViewState();
      this.#el.setViewState({ ...view, camera: structuredClone(pose) });
    } finally {
      this.#internal = false;
    }
  }

  #currentPose(): CameraPose | null {
    try {
      return structuredClone(this.#el.getViewState().camera);
    } catch {
      // 元素还没 ready：等第一条 view-change 再建基线。
      return null;
    }
  }

  #ensureCameraBaseline(): boolean {
    if (this.#cameraReady) return true;
    const pose = this.#currentPose();
    if (!pose) return false;
    this.#resetCamera(pose);
    return true;
  }

  #resetCamera(pose: CameraPose): void {
    this.#poses = [{ pose: structuredClone(pose), at: 0 }];
    this.#cameraIndex = 0;
    this.#cameraAt = 0;
    this.#cameraRecordAt = 0;
    this.#cameraReady = true;
  }

  #recordCamera(pose: CameraPose): void {
    const top = this.#poses[this.#cameraIndex];
    if (top && samePose(top.pose, pose)) return;

    const now = performance.now();
    const merging = now - this.#cameraRecordAt < CAMERA_MERGE_MS && this.#cameraIndex > 0;

    if (merging) {
      this.#poses[this.#cameraIndex] = { pose: structuredClone(pose), at: now };
    } else {
      this.#poses = this.#poses.slice(0, this.#cameraIndex + 1);
      this.#poses.push({ pose: structuredClone(pose), at: now });
      if (this.#poses.length > CAMERA_HISTORY_LIMIT) this.#poses.shift();
      this.#cameraIndex = this.#poses.length - 1;
    }

    this.#cameraRecordAt = now;
    this.#cameraAt = now;
    this.#redoOrder = [];
  }

  #onHistoryChange = (event: Event): void => {
    const detail = (event as CustomEvent<HistoryChangeDetail>).detail;
    this.#docCanUndo = detail.canUndo;
    this.#docCanRedo = detail.canRedo;
    if (this.#internal) return;

    // 新命令总会清空 redo 栈：用它区分「新编辑」和「撤销/重做」。
    if (detail.canUndo && !detail.canRedo) {
      this.#docEditAt = performance.now();
      this.#redoOrder = [];
    }
  };

  #onViewChange = (event: Event): void => {
    const detail = (event as CustomEvent<ViewChangeDetail>).detail;
    if (!this.#ensureCameraBaseline()) return;
    // 换文档：旧位姿对新场景没有意义，当前机位（或文档自带的 view）即新基线。
    if (detail.source === "load") {
      this.#resetCamera(detail.view.camera);
      return;
    }
    if (this.#internal) return;
    this.#recordCamera(detail.view.camera);
  };
}

function samePose(a: CameraPose, b: CameraPose): boolean {
  return (
    near(a.fov, b.fov) &&
    a.position.every((value, index) => near(value, b.position[index] ?? Number.NaN)) &&
    a.target.every((value, index) => near(value, b.target[index] ?? Number.NaN))
  );
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= POSE_EPSILON;
}

/**
 * Ctrl/Cmd+Z 与 Ctrl/Cmd+Y / Shift+Z。
 *
 * 用捕获阶段挂在 window 上：元素自己的按键处理只在焦点位于视口内时生效，
 * 捕获阶段可以抢先一步，避免两套逻辑各撤一次。输入框仍交给浏览器。
 *
 * 查看态也接这两个键 —— 视角与观看设置不是编辑，撤销它们不会改文档；
 * 「文档命令只在编辑态可撤」的门禁在 `HistoryCoordinator` 内部。
 */
export function bindHistoryHotkeys(
  history: HistoryCoordinator,
  target: Window = window,
): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;

    if (isTextEntry(event.target)) return;

    // 先撤，撤得动才拦截：撤不动时把按键原样留给别的处理器。
    const handled = key === "y" || event.shiftKey ? history.redo() : history.undo();
    if (!handled) return;

    event.preventDefault();
    event.stopPropagation();
  };

  target.addEventListener("keydown", handler, true);
  return () => target.removeEventListener("keydown", handler, true);
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}
