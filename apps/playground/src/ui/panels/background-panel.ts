import type { ViewerState, ViewerStore } from "../../viewer/viewer-state";
import { BasePanel } from "../panel";

export interface BackgroundPanelOptions {
  store: ViewerStore;
}

/** 与面板里的预设按钮一一对应；其余色值走自定义取色器。 */
const PRESET_BACKGROUNDS: readonly string[] = ["#0c0e12", "#050608", "#0a1526"];

/**
 * 视口背景：三个预设 + 一个自定义取色器。
 * 背景只影响观看，不属于灯光配置，因此单独成组。
 */
export class BackgroundPanel extends BasePanel {
  readonly #store: ViewerStore;
  #unsubscribe: (() => void) | null = null;

  constructor(options: BackgroundPanelOptions) {
    super();
    this.#store = options.store;
  }

  mount(): void {
    document.querySelectorAll<HTMLElement>(".bg-preset-btn").forEach((button) => {
      this.listen(button, "click", () => {
        const hex = button.dataset.bg;
        if (hex) this.#store.patch({ background: hex });
      });
    });

    const custom = document.querySelector<HTMLInputElement>("#bg-custom");
    if (custom) {
      this.listen(custom, "input", () => this.#store.patch({ background: custom.value }));
    }

    this.#unsubscribe = this.#store.subscribe((next) => this.sync(next));
    this.sync(this.#store.state);
  }

  sync(state: ViewerState): void {
    document.querySelectorAll<HTMLElement>(".bg-preset-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.bg === state.background);
    });

    const isPreset = PRESET_BACKGROUNDS.includes(state.background);
    document.querySelector("#bg-custom-chip")?.classList.toggle("active", !isPreset);

    const custom = document.querySelector<HTMLInputElement>("#bg-custom");
    if (custom && document.activeElement !== custom) custom.value = state.background;

    this.syncText("#bg-hex", state.background.toUpperCase());
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
