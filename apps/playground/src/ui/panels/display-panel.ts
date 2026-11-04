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

    this.click("#toggle-grid", () => {
      this.#store.patch({ grid: !this.#store.state.grid });
    });

    this.click("#toggle-skeleton", () => {
      this.#store.patch({ skeleton: !this.#store.state.skeleton });
    });

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

    this.syncActive("#toggle-grid", state.grid);
    this.syncText("#toggle-grid", `Floor Grid: ${state.grid ? "ON" : "OFF"}`);

    this.syncActive("#toggle-skeleton", state.skeleton);
    this.syncText("#toggle-skeleton", `Skeleton: ${state.skeleton ? "ON" : "OFF"}`);
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
