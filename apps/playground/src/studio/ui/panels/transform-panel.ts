import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime, TransformMode } from "@scenio/scene-editor/three";
import { BasePanel } from "../panel";

const GIZMO_BUTTONS: Record<TransformMode, string> = {
  translate: "#gizmo-t",
  rotate: "#gizmo-r",
  scale: "#gizmo-s",
};

export interface TransformPanelOptions {
  el: SceneEditorElement;
  getRuntime: () => ThreeRuntime | null;
}

/** Gizmo tool switcher (translate / rotate / scale / pointer). */
export class TransformPanel extends BasePanel {
  readonly #options: TransformPanelOptions;

  constructor(options: TransformPanelOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.click("#gizmo-t", () => this.setMode("translate"));
    this.click("#gizmo-r", () => this.setMode("rotate"));
    this.click("#gizmo-s", () => this.setMode("scale"));
    this.click("#gizmo-none", () => this.setMode("none"));
  }

  setMode(mode: TransformMode | "none"): void {
    if (mode === "none") {
      this.#options.el.clearSelection();
    } else {
      this.#options.getRuntime()?.setTransformMode(mode);
    }

    for (const selector of [...Object.values(GIZMO_BUTTONS), "#gizmo-none"]) {
      this.syncActive(selector, false);
    }
    this.syncActive(mode === "none" ? "#gizmo-none" : GIZMO_BUTTONS[mode], true);
  }
}
