import { BasePanel } from "../panel";

const REMOTE_MODEL_EXAMPLE =
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb";

export interface ModelPanelOptions {
  /** Load a built-in preset by `<select>` value. */
  loadPreset: (value: string) => Promise<void>;
  /** Load a single local file / remote URL. */
  loadCustom: (source: string | File) => Promise<void>;
  /** Load a dropped multi-file bundle (glTF + buffers + textures). */
  loadFiles: (files: File[]) => Promise<void>;
}

/** Model source picker: preset list, file picker, remote URL. */
export class ModelPanel extends BasePanel {
  readonly #options: ModelPanelOptions;

  constructor(options: ModelPanelOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    const select = document.querySelector<HTMLSelectElement>("#model-select");
    if (select) {
      this.listen(select, "change", () => {
        void this.#options.loadPreset(select.value);
      });
    }

    const fileInput = document.querySelector<HTMLInputElement>("#file-input");
    const upload = document.querySelector<HTMLElement>("#btn-upload");
    if (fileInput && upload) {
      // A .gltf almost always drags along .bin/textures — allow a bundle.
      fileInput.multiple = true;
      this.listen(upload, "click", () => fileInput.click());
      this.listen(fileInput, "change", () => {
        const files = Array.from(fileInput.files ?? []);
        // Reset so re-picking the same file fires `change` again.
        fileInput.value = "";
        if (files.length === 0) return;
        void (files.length === 1
          ? this.#options.loadCustom(files[0]!)
          : this.#options.loadFiles(files));
      });
    }

    this.click("#btn-url", () => {
      const url = window.prompt(
        "输入 3D 模型 URL（.glb / .gltf / .obj / .stl）",
        REMOTE_MODEL_EXAMPLE,
      );
      if (url) void this.#options.loadCustom(url.trim());
    });
  }

  /**
   * Reflect the loaded preset in the model `<select>`.
   * `null` resets it to the placeholder (home screen); custom files keep the last option.
   */
  selectModelOption(value: string | null): void {
    const select = document.querySelector<HTMLSelectElement>("#model-select");
    if (!select) return;
    if (!value) {
      select.value = "";
      return;
    }
    if (!Array.from(select.options).some((option) => option.value === value)) return;
    select.value = value;
  }
}
