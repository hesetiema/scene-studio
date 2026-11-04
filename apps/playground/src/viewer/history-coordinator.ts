import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ViewerStore } from "./viewer-state";

type Scope = "viewer" | "document";

interface HistoryChangeDetail {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  lastCommand?: string;
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

/**
 * 统一撤销/重做：面板设置（viewer state，valtio 快照栈）与文档命令（SDK 历史）
 * 共用一对按钮和 Ctrl+Z / Ctrl+Y。
 *
 * 撤销时比较两边最近一次改动的时间：谁更晚先撤谁；重做按撤销顺序回放。
 * 视觉设置是预览态，不进文档，因此必须有自己的栈。
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

  constructor(el: SceneEditorElement, store: ViewerStore) {
    this.#el = el;
    this.#store = store;

    el.addEventListener("history-change", this.#onHistoryChange);
    this.#unsubscribe = store.subscribe(() => {
      // 新的面板改动会截断重做栈，重做顺序也随之失效。
      if (!this.#internal && !this.#store.canRedo) this.#redoOrder = [];
    });
  }

  get canUndo(): boolean {
    return this.#store.canUndo || this.#docCanUndo;
  }

  get canRedo(): boolean {
    return this.#store.canRedo || this.#docCanRedo;
  }

  undo(): boolean {
    const viewerFirst =
      this.#store.canUndo && (!this.#docCanUndo || this.#store.lastChangeAt >= this.#docEditAt);

    if (viewerFirst && this.#undoViewer()) {
      this.#redoOrder.push("viewer");
      return true;
    }
    if (this.#undoDocument()) {
      this.#redoOrder.push("document");
      return true;
    }
    if (this.#undoViewer()) {
      this.#redoOrder.push("viewer");
      return true;
    }
    return false;
  }

  redo(): boolean {
    while (this.#redoOrder.length > 0) {
      const scope = this.#redoOrder.pop();
      if (scope === "viewer" && this.#redoViewer()) return true;
      if (scope === "document" && this.#redoDocument()) return true;
    }
    return this.#redoViewer() || this.#redoDocument();
  }

  destroy(): void {
    this.#el.removeEventListener("history-change", this.#onHistoryChange);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
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
    if (!this.#docCanUndo) return false;
    this.#internal = true;
    try {
      this.#el.undo();
    } finally {
      this.#internal = false;
    }
    return true;
  }

  #redoDocument(): boolean {
    if (!this.#docCanRedo) return false;
    this.#internal = true;
    try {
      this.#el.redo();
    } finally {
      this.#internal = false;
    }
    return true;
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
}

/**
 * Ctrl/Cmd+Z 与 Ctrl/Cmd+Y / Shift+Z。
 *
 * 用捕获阶段挂在 window 上：元素自己的按键处理只在焦点位于视口内时生效，
 * 捕获阶段可以抢先一步，避免两套逻辑各撤一次。输入框仍交给浏览器。
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

    event.preventDefault();
    event.stopPropagation();

    if (key === "y" || event.shiftKey) history.redo();
    else history.undo();
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
