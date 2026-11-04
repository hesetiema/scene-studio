import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import type { HUDController } from "../hud-controller";
import { captureSnapshot, exportDocument, type ExportFormat } from "../scene-export";
import { BasePanel } from "../panel";

export interface DocumentPanelOptions {
  el: SceneEditorElement;
  getRuntime: () => ThreeRuntime | null;
  hud: HUDController;
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
    this.click("#btn-undo", () => this.#options.el.undo());
    this.click("#btn-redo", () => this.#options.el.redo());

    this.click("#btn-snapshot", () => {
      const rt = this.#options.getRuntime();
      if (!rt) return;
      try {
        const filename = captureSnapshot(rt, this.#options.el, this.#options.el.getDocument());
        this.#options.hud.showToast(`Snapshot: ${filename}`);
      } catch (error) {
        this.#options.hud.showToast(error instanceof Error ? error.message : "截图失败");
      }
    });

    this.click("#btn-export-glb", () => void this.#export("glb"));
    this.click("#btn-export-obj", () => void this.#export("obj"));
  }

  async #export(format: ExportFormat): Promise<void> {
    const rt = this.#options.getRuntime();
    if (!rt) return;
    try {
      const filename = await exportDocument(rt, this.#options.el.getDocument(), format);
      this.#options.hud.showToast(`Export: ${filename}`);
    } catch (error) {
      this.#options.hud.showToast(error instanceof Error ? error.message : "导出失败");
    }
  }
}
