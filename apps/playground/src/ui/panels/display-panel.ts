import type { DisplayMode, ViewerState, ViewerStore } from "../../viewer/viewer-state";
import { BasePanel } from "../panel";

export interface DisplayPanelOptions {
  store: ViewerStore;
}

/**
 * Shading tabs, grid/skeleton toggles and the explode preview slider.
 * Every control patches the viewer store; nothing talks to ThreeRuntime directly.
 */
export class DisplayPanel extends BasePanel {
  readonly #store: ViewerStore;
  #unsubscribe: (() => void) | null = null;

  constructor(options: DisplayPanelOptions) {
    super();
    this.#store = options.store;
  }

  mount(): void {
    document.querySelectorAll<HTMLElement>(".mode-tab[data-mode]").forEach((tab) => {
      this.listen(tab, "click", () => {
        const mode = tab.dataset.mode as DisplayMode | undefined;
        if (mode) this.#store.patch({ display: mode });
      });
    });

    const grid = document.querySelector<HTMLInputElement>("#toggle-grid");
    if (grid) {
      this.listen(grid, "change", () => this.#store.patch({ grid: grid.checked }));
    }

    const skeleton = document.querySelector<HTMLInputElement>("#toggle-skeleton");
    if (skeleton) {
      this.listen(skeleton, "change", () => this.#store.patch({ skeleton: skeleton.checked }));
    }

    const slider = document.querySelector<HTMLInputElement>("#explode-slider");
    if (slider) {
      this.listen(slider, "input", () =>
        this.#store.patch({ explode: Number(slider.value) / 100 }),
      );
    }

    this.#unsubscribe = this.#store.subscribe((next) => this.sync(next));
    this.sync(this.#store.state);
  }

  sync(state: ViewerState): void {
    document.querySelectorAll<HTMLElement>(".mode-tab[data-mode]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === state.display);
    });

    const grid = document.querySelector<HTMLInputElement>("#toggle-grid");
    if (grid) grid.checked = state.grid;

    const skeleton = document.querySelector<HTMLInputElement>("#toggle-skeleton");
    if (skeleton) skeleton.checked = state.skeleton;

    const slider = document.querySelector<HTMLInputElement>("#explode-slider");
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(state.explode * 100));
    const label = document.querySelector<HTMLElement>("#explode-val");
    if (label) label.textContent = `${Math.round(state.explode * 100)}%`;
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
