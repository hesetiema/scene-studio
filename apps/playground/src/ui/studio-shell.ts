import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime, TransformMode } from "@scenio/scene-editor/three";
import type { CameraController, CameraPreset } from "../camera/camera-controller";
import { bindHotkeys } from "../interaction/hotkeys";
import type { HUDController } from "./hud-controller";
import { ExplodeController } from "./explode-controller";
import { ViewModeController, type DisplayMode } from "./view-mode-controller";
import {
  ScenePresetController,
  DEFAULT_BACKDROP,
  type LightingPresetId,
} from "./scene-presets";
import { captureSnapshot, exportDocument, type ExportFormat } from "./scene-export";

export interface StudioShellOptions {
  el: SceneEditorElement;
  getRuntime: () => ThreeRuntime | null;
  hud: HUDController;
  camera: CameraController;
  /** Load a built-in preset by `<select>` value. */
  loadPreset: (value: string) => Promise<void>;
  /** Load a local file / remote URL. */
  loadCustom: (source: string | File) => Promise<void>;
}

const REMOTE_MODEL_EXAMPLE =
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb";

const MODE_BY_SHORTCUT: Record<string, DisplayMode> = {
  "1": "studio",
  "2": "xray",
  "3": "wireframe",
  "4": "normal",
  "5": "clay",
};

const GIZMO_BY_SHORTCUT: Record<string, TransformMode> = {
  g: "translate",
  r: "rotate",
  s: "scale",
};

const GIZMO_BUTTONS: Record<TransformMode, string> = {
  translate: "#gizmo-t",
  rotate: "#gizmo-r",
  scale: "#gizmo-s",
};

/**
 * Host chrome wiring for the playground: toolbar, presets, gizmo, hotkeys,
 * drag & drop, snapshot/export.
 *
 * `main.ts` keeps the host-side concerns (runtime factory, save/conflict store,
 * boot sequence); everything DOM-facing lives here so the two don't grow back
 * into one 700-line file.
 */
export class StudioShell {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;
  readonly #hud: HUDController;
  readonly #camera: CameraController;
  readonly #loadPreset: (value: string) => Promise<void>;
  readonly #loadCustom: (source: string | File) => Promise<void>;

  readonly viewModes: ViewModeController;
  readonly explode: ExplodeController;
  readonly presets: ScenePresetController;

  readonly #disposers: Array<() => void> = [];
  #dragDepth = 0;

  constructor(options: StudioShellOptions) {
    this.#el = options.el;
    this.#getRuntime = options.getRuntime;
    this.#hud = options.hud;
    this.#camera = options.camera;
    this.#loadPreset = options.loadPreset;
    this.#loadCustom = options.loadCustom;

    this.viewModes = new ViewModeController(options.el, options.getRuntime);
    this.explode = new ExplodeController(options.el, options.getRuntime);
    this.presets = new ScenePresetController(options.el);
  }

  mount(): void {
    this.#bindModelSources();
    this.#bindDisplayModes();
    this.#bindCameraTools();
    this.#bindGizmoTools();
    this.#bindScenePresets();
    this.#bindDocumentActions();
    this.#bindDragAndDrop();
    this.#bindKeys();

    this.#hud.startFpsCounter();
    this.presets.syncUI();
    this.#syncTurntableButton(false);
  }

  /** Reflect the loaded preset in the model `<select>` (custom files keep the last option). */
  selectModelOption(value: string | null): void {
    if (!value) return;
    const select = document.querySelector<HTMLSelectElement>("#model-select");
    if (!select) return;
    if (!Array.from(select.options).some((option) => option.value === value)) return;
    select.value = value;
  }

  /** Re-sync the viewer after `loadDocument()` — modes, explode baseline, presets. */
  onDocumentLoaded(): void {
    this.viewModes.reset();
    this.explode.reset();
    this.presets.syncUI();
    this.#syncTurntableButton(this.#camera.turntableActive);
  }

  destroy(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.#camera.stopTurntable();
    this.viewModes.dispose();
    this.#hud.destroy();
  }

  #bindModelSources(): void {
    const select = document.querySelector<HTMLSelectElement>("#model-select");
    if (select) {
      this.#listen(select, "change", () => {
        void this.#loadPreset(select.value);
      });
    }

    const fileInput = document.querySelector<HTMLInputElement>("#file-input");
    const upload = document.querySelector<HTMLElement>("#btn-upload");
    if (upload && fileInput) {
      this.#listen(upload, "click", () => fileInput.click());
      this.#listen(fileInput, "change", () => {
        const file = fileInput.files?.[0];
        // Reset so re-picking the same file fires `change` again.
        fileInput.value = "";
        if (file) void this.#loadCustom(file);
      });
    }

    const urlButton = document.querySelector<HTMLElement>("#btn-url");
    if (urlButton) {
      this.#listen(urlButton, "click", () => {
        const url = window.prompt("输入 3D 模型 URL（.glb / .gltf / .obj / .stl）", REMOTE_MODEL_EXAMPLE);
        if (url) void this.#loadCustom(url.trim());
      });
    }
  }

  #bindDisplayModes(): void {
    document.querySelectorAll<HTMLElement>(".mode-tab[data-mode]").forEach((tab) => {
      this.#listen(tab, "click", () => {
        const mode = tab.dataset.mode as DisplayMode | undefined;
        if (mode) this.viewModes.apply(mode);
      });
    });
  }

  #bindCameraTools(): void {
    this.#click("#btn-frame", () => {
      this.#camera.frameScene(true);
      this.#hud.showToast("Frame: scene centered");
    });

    this.#click("#btn-reset-cam", () => {
      this.#camera.resetCamera(true);
      this.#hud.showToast("Camera Reset [H]");
    });

    this.#click("#btn-turntable", () => {
      this.#syncTurntableButton(this.#camera.toggleTurntable());
    });

    const presets: Array<[CameraPreset, string]> = [
      ["iso", "#cam-iso"],
      ["top", "#cam-top"],
      ["front", "#cam-front"],
      ["side", "#cam-side"],
    ];
    for (const [preset, selector] of presets) {
      this.#click(selector, () => this.#setCameraPreset(preset));
    }
  }

  #bindGizmoTools(): void {
    this.#click("#gizmo-t", () => this.#setGizmo("translate"));
    this.#click("#gizmo-r", () => this.#setGizmo("rotate"));
    this.#click("#gizmo-s", () => this.#setGizmo("scale"));
    this.#click("#gizmo-none", () => this.#setGizmo("none"));
  }

  #bindScenePresets(): void {
    const slider = document.querySelector<HTMLInputElement>("#explode-slider");
    if (slider) {
      this.#listen(slider, "input", () => {
        this.explode.setFactor(Number(slider.value) / 100);
      });
    }

    this.#click("#toggle-grid", () => {
      const visible = this.presets.toggleGrid();
      this.#hud.showToast(`Grid: ${visible ? "Visible" : "Hidden"}`);
    });

    document.querySelectorAll<HTMLElement>(".bg-preset-btn").forEach((btn) => {
      this.#listen(btn, "click", () => {
        const hex = btn.dataset.bg || DEFAULT_BACKDROP;
        this.presets.applyBackdrop(hex);
        // Keep the page chrome in sync with the 3D background (no flash on resize).
        document.body.style.backgroundColor = hex;
        this.#el.style.backgroundColor = hex;
        this.#hud.showToast(`Backdrop: ${btn.textContent?.trim() ?? hex}`);
      });
    });

    document.querySelectorAll<HTMLElement>(".light-preset-btn").forEach((btn) => {
      this.#listen(btn, "click", () => {
        const preset = btn.dataset.light as LightingPresetId | undefined;
        if (!preset) return;
        this.presets.applyLighting(preset);
        this.#hud.showToast(`Light: ${preset.toUpperCase()}`);
      });
    });
  }

  #bindDocumentActions(): void {
    this.#click("#btn-save", () => this.#el.requestSave());
    this.#click("#btn-undo", () => this.#el.undo());
    this.#click("#btn-redo", () => this.#el.redo());

    this.#click("#btn-snapshot", () => {
      const rt = this.#getRuntime();
      if (!rt) return;
      try {
        const filename = captureSnapshot(rt, this.#el, this.#el.getDocument());
        this.#hud.showToast(`Snapshot: ${filename}`);
      } catch (error) {
        this.#hud.showToast(error instanceof Error ? error.message : "截图失败");
      }
    });

    this.#click("#btn-export-glb", () => void this.#export("glb"));
    this.#click("#btn-export-obj", () => void this.#export("obj"));
  }

  #bindDragAndDrop(): void {
    const overlay = document.querySelector<HTMLElement>("#drop-overlay");

    this.#listen<DragEvent>(window, "dragenter", (event) => {
      event.preventDefault();
      this.#dragDepth += 1;
      overlay?.classList.add("visible");
    });

    this.#listen<DragEvent>(window, "dragleave", (event) => {
      event.preventDefault();
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (this.#dragDepth === 0) overlay?.classList.remove("visible");
    });

    this.#listen<DragEvent>(window, "dragover", (event) => event.preventDefault());

    this.#listen<DragEvent>(window, "drop", (event) => {
      event.preventDefault();
      this.#dragDepth = 0;
      overlay?.classList.remove("visible");
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.#loadCustom(file);
    });
  }

  #bindKeys(): void {
    const off = bindHotkeys({
      ...Object.fromEntries(
        Object.entries(MODE_BY_SHORTCUT).map(([key, mode]) => [key, () => this.viewModes.apply(mode)]),
      ),
      ...Object.fromEntries(
        Object.entries(GIZMO_BY_SHORTCUT).map(([key, mode]) => [key, () => this.#setGizmo(mode)]),
      ),
      f: () => this.#camera.frameScene(true),
      h: () => {
        this.#camera.resetCamera(true);
        this.#hud.showToast("Camera Reset [H]");
      },
      "7": () => this.#setCameraPreset("top"),
      space: () => this.#syncTurntableButton(this.#camera.toggleTurntable()),
    });
    this.#disposers.push(off);
  }

  #setCameraPreset(preset: CameraPreset): void {
    this.#camera.setCameraPreset(preset, true);

    const { distance } = this.#camera.getBoundingInfo();
    const stat = document.querySelector<HTMLElement>("#hud-cam-stat");
    if (stat) stat.textContent = `CAM: ${preset.toUpperCase()} · DIST: ${distance.toFixed(1)}m`;

    document.querySelectorAll("#cam-iso, #cam-top, #cam-front, #cam-side").forEach((btn) => {
      btn.classList.toggle("active", btn.id === `cam-${preset}`);
    });
    this.#hud.showToast(`Camera: ${preset.toUpperCase()}`);
  }

  #setGizmo(mode: TransformMode | "none"): void {
    if (mode === "none") {
      this.#el.clearSelection();
    } else {
      this.#getRuntime()?.setTransformMode(mode);
    }

    document
      .querySelectorAll("#gizmo-t, #gizmo-r, #gizmo-s, #gizmo-none")
      .forEach((btn) => btn.classList.remove("active"));
    const active = mode === "none" ? "#gizmo-none" : GIZMO_BUTTONS[mode];
    document.querySelector(active)?.classList.add("active");
  }

  async #export(format: ExportFormat): Promise<void> {
    const rt = this.#getRuntime();
    if (!rt) return;
    try {
      const filename = await exportDocument(rt, this.#el.getDocument(), format);
      this.#hud.showToast(`Export: ${filename}`);
    } catch (error) {
      this.#hud.showToast(error instanceof Error ? error.message : "导出失败");
    }
  }

  #syncTurntableButton(active: boolean): void {
    document.querySelector("#btn-turntable")?.classList.toggle("active", active);
  }

  #click(selector: string, handler: () => void): void {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) this.#listen(element, "click", handler);
  }

  #listen<E extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
  ): void {
    target.addEventListener(type, handler as EventListener);
    this.#disposers.push(() => target.removeEventListener(type, handler as EventListener));
  }
}
