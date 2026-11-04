export interface DropZoneOptions {
  /** Receive every dropped file (a .gltf bundle arrives together). */
  onFiles: (files: File[]) => void | Promise<void>;
}

/**
 * Window-level drag & drop with a depth counter so the overlay does not flicker
 * while crossing child elements (same approach as three-gltf-viewer's dropzone).
 */
export class DropZone {
  readonly #options: DropZoneOptions;
  readonly #overlay: HTMLElement | null;
  readonly #disposers: Array<() => void> = [];
  #depth = 0;

  constructor(options: DropZoneOptions) {
    this.#options = options;
    this.#overlay = document.querySelector<HTMLElement>("#drop-overlay");
  }

  mount(): void {
    this.#listen<DragEvent>(window, "dragenter", (event) => {
      event.preventDefault();
      this.#depth += 1;
      this.#overlay?.classList.add("visible");
    });

    this.#listen<DragEvent>(window, "dragleave", (event) => {
      event.preventDefault();
      this.#depth = Math.max(0, this.#depth - 1);
      if (this.#depth === 0) this.#overlay?.classList.remove("visible");
    });

    this.#listen<DragEvent>(window, "dragover", (event) => event.preventDefault());

    this.#listen<DragEvent>(window, "drop", (event) => {
      event.preventDefault();
      this.#depth = 0;
      this.#overlay?.classList.remove("visible");
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void this.#options.onFiles(files);
    });
  }

  destroy(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.#overlay?.classList.remove("visible");
    this.#depth = 0;
  }

  #listen<E extends Event>(target: EventTarget, type: string, handler: (event: E) => void): void {
    target.addEventListener(type, handler as EventListener);
    this.#disposers.push(() => target.removeEventListener(type, handler as EventListener));
  }
}
