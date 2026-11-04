import type {
  LightingPresetId,
  ToneMappingId,
  ViewerState,
  ViewerStore,
} from "../../viewer/viewer-state";
import { LIGHTING_PRESETS } from "../../viewer/presets";
import { BasePanel } from "../panel";

export interface LightingPanelOptions {
  store: ViewerStore;
}

/**
 * 灯光：环境预设 + 环境光/主光的强度与颜色 + 曝光、色调映射。
 * 强度与颜色是叠加在预设之上的预览参数；换预设时一并复位。
 * 背景色属于 `BackgroundPanel`，材质属于 `MaterialPanel`。
 */
export class LightingPanel extends BasePanel {
  readonly #store: ViewerStore;
  #unsubscribe: (() => void) | null = null;

  constructor(options: LightingPanelOptions) {
    super();
    this.#store = options.store;
  }

  mount(): void {
    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((button) => {
      this.listen(button, "click", () => {
        const preset = button.dataset.light as LightingPresetId | undefined;
        if (!preset) return;
        this.#store.patch({
          lighting: preset,
          ambientScale: 1,
          directionalScale: 1,
          ambientColor: null,
          directionalColor: null,
        });
      });
    });

    this.#bindScale("#ibl-scale", "#ibl-scale-val", (value) =>
      this.#store.patch({ iblIntensity: value / 100 }),
    );
    this.#bindScale("#ambient-scale", "#ambient-scale-val", (value) =>
      this.#store.patch({ ambientScale: value / 100 }),
    );
    this.#bindScale("#directional-scale", "#directional-scale-val", (value) =>
      this.#store.patch({ directionalScale: value / 100 }),
    );

    const exposure = document.querySelector<HTMLInputElement>("#exposure-slider");
    if (exposure) {
      this.listen(exposure, "input", () => {
        this.#store.patch({ exposure: Number(exposure.value) });
      });
    }

    const ambientColor = document.querySelector<HTMLInputElement>("#ambient-color");
    if (ambientColor) {
      this.listen(ambientColor, "input", () => {
        this.#store.patch({ ambientColor: ambientColor.value });
      });
    }

    const directionalColor = document.querySelector<HTMLInputElement>("#directional-color");
    if (directionalColor) {
      this.listen(directionalColor, "input", () => {
        this.#store.patch({ directionalColor: directionalColor.value });
      });
    }

    const follow = document.querySelector<HTMLInputElement>("#follow-camera");
    if (follow) {
      this.listen(follow, "change", () => {
        this.#store.patch({ followCamera: follow.checked });
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
    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.light === state.lighting);
    });

    const preset = LIGHTING_PRESETS[state.lighting];

    const iblScale = document.querySelector<HTMLInputElement>("#ibl-scale");
    if (iblScale) iblScale.value = String(Math.round(state.iblIntensity * 100));
    this.syncText("#ibl-scale-val", `${Math.round(state.iblIntensity * 100)}%`);

    const ambientScale = document.querySelector<HTMLInputElement>("#ambient-scale");
    if (ambientScale) ambientScale.value = String(Math.round(state.ambientScale * 100));
    this.syncText("#ambient-scale-val", `${Math.round(state.ambientScale * 100)}%`);

    const directionalScale = document.querySelector<HTMLInputElement>("#directional-scale");
    if (directionalScale) directionalScale.value = String(Math.round(state.directionalScale * 100));
    this.syncText("#directional-scale-val", `${Math.round(state.directionalScale * 100)}%`);

    const exposure = document.querySelector<HTMLInputElement>("#exposure-slider");
    if (exposure && document.activeElement !== exposure) {
      exposure.value = String(state.exposure);
    }
    this.syncText("#exposure-val", state.exposure.toFixed(2));

    const ambientColorValue = state.ambientColor ?? preset.ambient.color;
    const ambientColor = document.querySelector<HTMLInputElement>("#ambient-color");
    if (ambientColor) ambientColor.value = ambientColorValue;
    this.syncText("#ambient-color-hex", ambientColorValue.toUpperCase());

    const directionalColorValue = state.directionalColor ?? preset.directional.color;
    const directionalColor = document.querySelector<HTMLInputElement>("#directional-color");
    if (directionalColor) directionalColor.value = directionalColorValue;
    this.syncText("#directional-color-hex", directionalColorValue.toUpperCase());

    const follow = document.querySelector<HTMLInputElement>("#follow-camera");
    if (follow) follow.checked = state.followCamera;

    const toneMapping = document.querySelector<HTMLSelectElement>("#tone-mapping");
    if (toneMapping) toneMapping.value = state.toneMapping;
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #bindScale(sliderId: string, valueId: string, onChange: (value: number) => void): void {
    const slider = document.querySelector<HTMLInputElement>(sliderId);
    if (!slider) return;
    this.listen(slider, "input", () => {
      const value = Number(slider.value);
      this.syncText(valueId, `${Math.round(value)}%`);
      onChange(value);
    });
  }
}
