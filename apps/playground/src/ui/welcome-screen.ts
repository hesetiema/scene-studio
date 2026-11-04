import { BasePanel } from "./panel";

export interface WelcomeScreenOptions {
  /** Load a built-in sample by `<select>` value. */
  onPickPreset: (value: string) => void;
  /** Forward to the header's file button — one file-picking path only. */
  onUpload: () => void;
}

/**
 * Empty state shown when the playground boots with no document.
 *
 * Nothing is loaded on the bare URL: the user either drops a file or picks a
 * Khronos sample here, which is what keeps a first visit from downloading a
 * multi-megabyte model before the user asked for one.
 */
export class WelcomeScreen extends BasePanel {
  readonly #options: WelcomeScreenOptions;
  #root: HTMLElement | null = null;

  constructor(options: WelcomeScreenOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.#root = document.querySelector<HTMLElement>("#welcome");
    if (!this.#root) return;

    this.#root.querySelectorAll<HTMLElement>(".sample-chip").forEach((chip) => {
      this.listen(chip, "click", () => {
        const model = chip.dataset.model;
        if (model) this.#options.onPickPreset(model);
      });
    });

    this.click("#welcome-upload", () => this.#options.onUpload());
  }

  get visible(): boolean {
    return this.#root ? !this.#root.hidden : false;
  }

  show(): void {
    this.#toggle(true);
  }

  hide(): void {
    this.#toggle(false);
  }

  #toggle(visible: boolean): void {
    if (!this.#root) return;
    this.#root.hidden = !visible;
    document.body.dataset.welcome = visible ? "true" : "false";
  }
}
