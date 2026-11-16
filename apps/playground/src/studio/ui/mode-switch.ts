import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { HUDController } from "./hud-controller";
import { BasePanel } from "./panel";

/** The studio's two faces. The SDK element uses the same two ids for `mode`. */
export type StudioMode = "viewer" | "editor";

export interface ModeSwitchOptions {
  el: SceneEditorElement;
  hud: HUDController;
}

const BUTTON: Record<StudioMode, string> = {
  viewer: "#mode-viewer",
  editor: "#mode-editor",
};

const LABEL: Record<StudioMode, string> = {
  viewer: "查看模式：只浏览模型，隐藏编辑面板与坐标轴",
  editor: "编辑模式：显示变换工具、材质、文档与导出面板",
};

/**
 * Top-bar viewer/editor switch.
 *
 * The studio loads a host document (`loadDocument()`), which the SDK would
 * otherwise derive as `mode="editor"`. Here the *page* decides: a freshly
 * loaded model is a viewer first — full-bleed canvas, no gizmo, no authoring
 * chrome — and the editor is one click away. Switching writes `el.mode`, which
 * the SDK turns into `setInteractive()` (gizmo mount/unmount) and, on the way
 * back to viewer, `clearSelection()`.
 *
 * CSS keys off `body[data-studio-mode]`; nothing here touches the document, so
 * flipping modes never marks the scene dirty. `?mode=editor` is applied before
 * the element upgrades (see `main.ts`), which is why `mount()` reads the
 * element instead of assuming "viewer".
 */
export class ModeSwitch extends BasePanel {
  readonly #options: ModeSwitchOptions;
  #mode: StudioMode = "viewer";

  constructor(options: ModeSwitchOptions) {
    super();
    this.#options = options;
  }

  get mode(): StudioMode {
    return this.#mode;
  }

  mount(): void {
    this.#mode = this.#options.el.mode === "editor" ? "editor" : "viewer";

    for (const mode of Object.keys(BUTTON) as StudioMode[]) {
      const button = document.querySelector<HTMLButtonElement>(BUTTON[mode]);
      if (button) this.listen(button, "click", () => this.set(mode));
    }

    this.#reflect(false);
  }

  /** Switch mode. `notify: false` is the initial sync (no toast on boot). */
  set(mode: StudioMode, notify = true): void {
    if (mode === this.#mode && this.#options.el.mode === mode) return;
    this.#mode = mode;
    this.#reflect(notify);
  }

  toggle(): void {
    this.set(this.#mode === "viewer" ? "editor" : "viewer");
  }

  #reflect(notify: boolean): void {
    const mode = this.#mode;

    document.body.dataset.studioMode = mode;
    if (this.#options.el.mode !== mode) this.#options.el.mode = mode;

    for (const key of Object.keys(BUTTON) as StudioMode[]) {
      const button = document.querySelector<HTMLButtonElement>(BUTTON[key]);
      if (!button) continue;
      const active = key === mode;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.classList.toggle("active", active);
      button.title = LABEL[key];
    }

    // `mode="viewer"` clears the SDK selection; keep the (hidden) inspector
    // honest for when the user switches back.
    this.#options.hud.updateSelectionUI();
    if (notify) {
      this.#options.hud.showToast(mode === "editor" ? "已进入编辑模式" : "已切回查看模式");
    }
  }
}
