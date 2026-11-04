import type {
  LightingPresetId,
  ToneMappingId,
  ViewerState,
  ViewerStore,
} from "../../viewer/viewer-state";
import { BasePanel } from "../panel";

export interface LightingPanelOptions {
  store: ViewerStore;
}

/** Backdrop, lighting preset, exposure and tone mapping. */
export class LightingPanel extends BasePanel {
  readonly #store: ViewerStore;
  #unsubscribe: (() => void) | null = null;

  constructor(options: LightingPanelOptions) {
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

    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((button) => {
      this.listen(button, "click", () => {
        const preset = button.dataset.light as LightingPresetId | undefined;
        if (preset) this.#store.patch({ lighting: preset });
      });
    });

    const exposure = document.querySelector<HTMLInputElement>("#exposure-slider");
    if (exposure) {
      this.listen(exposure, "input", () => {
        this.#store.patch({ exposure: Number(exposure.value) });
      });
    }

    const toneMapping = document.querySelector<HTMLSelectElement>("#tone-mapping");
    if (toneMapping) {
      this.listen(toneMapping, "change", () => {
        this.#store.patch({ toneMapping: toneMapping.value as ToneMappingId });
      });
    }

    this.#unsubscribe = this.#store.subscribe((next) => this.sync(next));
    this.sync(this.#store.state);
  }

  sync(state: ViewerState): void {
    document.querySelectorAll<HTMLElement>(".bg-preset-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.bg === state.background);
    });
    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.light === state.lighting);
    });

    const exposure = document.querySelector<HTMLInputElement>("#exposure-slider");
    if (exposure && document.activeElement !== exposure) {
      exposure.value = String(state.exposure);
    }
    this.syncText("#exposure-val", state.exposure.toFixed(2));

    const toneMapping = document.querySelector<HTMLSelectElement>("#tone-mapping");
    if (toneMapping) toneMapping.value = state.toneMapping;
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
