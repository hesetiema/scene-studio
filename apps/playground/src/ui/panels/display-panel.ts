import type { ExplodeController } from "../explode-controller";
import type { DisplayMode, ViewerState, ViewerStore } from "../../viewer/viewer-state";
import { BasePanel } from "../panel";

export interface DisplayPanelOptions {
  store: ViewerStore;
  explode: ExplodeController;
}

/**
 * Shading tabs, grid/skeleton toggles and the explode preview slider.
 * Every control patches the viewer store; nothing talks to ThreeRuntime directly.
 */
export class DisplayPanel extends BasePanel {
  readonly #store: ViewerStore;
  readonly #explode: ExplodeController;
  #unsubscribe: (() => void) | null = null;

  constructor(options: DisplayPanelOptions) {
    super();
    this.#store = options.store;
    this.#explode = options.explode;
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
      this.listen(slider, "input", () => this.#explode.setFactor(Number(slider.value) / 100));
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
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
