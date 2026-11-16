import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { MaterialController, MaterialValues } from "../material-controller";
import { BasePanel } from "../panel";

export interface MaterialPanelOptions {
  el: SceneEditorElement;
  material: MaterialController;
}

/** 选中部件的材质参数（颜色 / 透明度 / 金属度 / 粗糙度）。 */
export class MaterialPanel extends BasePanel {
  readonly #el: SceneEditorElement;
  readonly #material: MaterialController;

  constructor(options: MaterialPanelOptions) {
    super();
    this.#el = options.el;
    this.#material = options.material;
  }

  mount(): void {
    const color = document.querySelector<HTMLInputElement>("#material-color");
    if (color) {
      this.listen(color, "input", () => {
        this.#material.setColor(color.value);
        this.syncText("#material-color-hex", color.value.toUpperCase());
      });
    }

    this.#bindRange("#material-opacity", "#material-opacity-val", (value) => {
      this.#material.setOpacity(value / 100);
    });
    this.#bindRange("#material-metalness", "#material-metalness-val", (value) => {
      this.#material.setMetalness(value / 100);
    });
    this.#bindRange("#material-roughness", "#material-roughness-val", (value) => {
      this.#material.setRoughness(value / 100);
    });

    this.click("#btn-material-apply", () => {
      this.#material.apply();
      this.refreshHint();
    });

    this.click("#btn-material-reset", () => {
      this.#material.reset();
      this.syncFromSelection();
      this.refreshHint();
    });

    this.listen(this.#el, "selection-change", () => {
      this.#material.syncSelection();
      this.syncFromSelection();
      this.refreshHint();
    });

    this.syncFromSelection();
    this.refreshHint();
  }

  /** 把选中部件当前的材质参数回填到面板控件。 */
  syncFromSelection(): void {
    const values = this.#material.readSelection();
    if (!values) return;

    this.#material.adopt(values);
    this.#writeControls(values);
  }

  /** 选中数量变化或换文档后刷新提示文案。 */
  refreshHint(): void {
    const count = this.#material.selectedMeshCount;
    const hint = document.querySelector("#material-hint");
    if (!hint) return;
    hint.textContent =
      count > 0
        ? `已选中 ${count} 个网格，调整写入文档（Ctrl+Z 可撤销）`
        : "未选中部件：先在视口中点击模型";
    hint.classList.toggle("muted", count === 0);
  }

  #writeControls(values: MaterialValues): void {
    const color = document.querySelector<HTMLInputElement>("#material-color");
    if (color) color.value = values.color;
    this.syncText("#material-color-hex", values.color.toUpperCase());

    this.#writeRange("#material-opacity", "#material-opacity-val", values.opacity * 100);
    this.#writeRange("#material-metalness", "#material-metalness-val", values.metalness * 100);
    this.#writeRange("#material-roughness", "#material-roughness-val", values.roughness * 100);
  }

  #bindRange(sliderId: string, valueId: string, onChange: (value: number) => void): void {
    const slider = document.querySelector<HTMLInputElement>(sliderId);
    if (!slider) return;
    this.listen(slider, "input", () => {
      const value = Number(slider.value);
      onChange(value);
      this.syncText(valueId, `${Math.round(value)}%`);
    });
  }

  #writeRange(sliderId: string, valueId: string, percent: number): void {
    const slider = document.querySelector<HTMLInputElement>(sliderId);
    if (slider) slider.value = String(Math.round(percent));
    this.syncText(valueId, `${Math.round(percent)}%`);
  }
}
