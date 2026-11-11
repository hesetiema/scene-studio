import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { HistoryCoordinator } from "../../viewer/history-coordinator";
import type { HUDController } from "../hud-controller";
import { captureSnapshot, exportDocument, type ExportFormat } from "../scene-export";
import { BasePanel } from "../panel";

export interface DocumentPanelOptions {
  el: SceneEditorElement;
  hud: HUDController;
  /** 统一撤销/重做（面板设置 + 文档命令）。 */
  history: HistoryCoordinator;
}

/** Save / history / snapshot / export actions. */
export class DocumentPanel extends BasePanel {
  readonly #options: DocumentPanelOptions;

  constructor(options: DocumentPanelOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.click("#btn-save", () => this.#options.el.requestSave());
    this.click("#btn-undo", () => this.#options.history.undo());
    this.click("#btn-redo", () => this.#options.history.redo());

    this.click("#btn-snapshot", () => void this.#snapshot());

    this.click("#btn-export-glb", () => void this.#export("glb"));
    this.click("#btn-export-obj", () => void this.#export("obj"));
  }

  async #snapshot(): Promise<void> {
    try {
      const filename = await captureSnapshot(this.#options.el);
      this.#options.hud.showToast(`截图已保存：${filename}`);
    } catch (error) {
      this.#options.hud.showToast(error instanceof Error ? error.message : "截图失败");
    }
  }

  async #export(format: ExportFormat): Promise<void> {
    try {
      const filename = await exportDocument(this.#options.el, format);
      this.#options.hud.showToast(`已导出：${filename}`);
    } catch (error) {
      this.#options.hud.showToast(error instanceof Error ? error.message : "导出失败");
    }
  }
}
