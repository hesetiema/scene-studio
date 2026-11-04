import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import type { CameraController } from "../camera/camera-controller";
import type { ViewerController } from "../viewer/viewer-controller";
import type { DisplayMode, ViewerStore } from "../viewer/viewer-state";
import { bindHotkeys } from "../interaction/hotkeys";
import { DropZone } from "./drop-zone";
import type { HUDController } from "./hud-controller";
import { ExplodeController } from "./explode-controller";
import { AnimationPanel } from "./panels/animation-panel";
import { CameraPanel } from "./panels/camera-panel";
import { DisplayPanel } from "./panels/display-panel";
import { DocumentPanel } from "./panels/document-panel";
import { LightingPanel } from "./panels/lighting-panel";
import { ModelPanel } from "./panels/model-panel";
import { TransformPanel } from "./panels/transform-panel";
import type { Panel } from "./panel";

export interface StudioShellOptions {
  el: SceneEditorElement;
  getRuntime: () => ThreeRuntime | null;
  hud: HUDController;
  camera: CameraController;
  store: ViewerStore;
  viewer: ViewerController;
  /** Load a built-in preset by `<select>` value. */
  loadPreset: (value: string) => Promise<void>;
  /** Load a local file / remote URL. */
  loadCustom: (source: string | File) => Promise<void>;
  /** Load a multi-file glTF bundle (glTF + buffers + textures). */
  loadFiles: (files: File[]) => Promise<void>;
}

const MODE_BY_SHORTCUT: Record<string, DisplayMode> = {
  "1": "studio",
  "2": "xray",
  "3": "wireframe",
  "4": "normal",
  "5": "clay",
};

/**
 * Composition root for the host chrome.
 *
 * Each panel owns one concern and talks to the viewer store, not to Three
 * (reference: three-gltf-viewer's `Viewer#addGUI` folders). `main.ts` keeps
 * host concerns — runtime factory, save/conflict store, boot sequence.
 */
export class StudioShell {
  readonly explode: ExplodeController;
  readonly model: ModelPanel;
  readonly transform: TransformPanel;
  readonly cameraPanel: CameraPanel;
  readonly display: DisplayPanel;
  readonly lighting: LightingPanel;
  readonly animation: AnimationPanel;
  readonly document: DocumentPanel;

  readonly #options: StudioShellOptions;
  readonly #panels: Panel[];
  readonly #dropZone: DropZone;
  readonly #disposers: Array<() => void> = [];

  constructor(options: StudioShellOptions) {
    this.#options = options;
    this.explode = new ExplodeController(options.el, options.getRuntime);

    this.model = new ModelPanel({
      loadPreset: options.loadPreset,
      loadCustom: options.loadCustom,
      loadFiles: options.loadFiles,
    });

    this.transform = new TransformPanel({
      el: options.el,
      getRuntime: options.getRuntime,
    });

    this.cameraPanel = new CameraPanel({
      camera: options.camera,
      hud: options.hud,
      store: options.store,
    });

    this.display = new DisplayPanel({ store: options.store, explode: this.explode });
    this.lighting = new LightingPanel({ store: options.store });

    this.animation = new AnimationPanel({
      store: options.store,
      viewer: options.viewer,
      getRuntime: options.getRuntime,
    });

    this.document = new DocumentPanel({
      el: options.el,
      getRuntime: options.getRuntime,
      hud: options.hud,
    });

    this.#panels = [
      this.model,
      this.transform,
      this.cameraPanel,
      this.display,
      this.lighting,
      this.animation,
      this.document,
    ];

    this.#dropZone = new DropZone({
      onFiles: (files) =>
        files.length === 1
          ? options.loadCustom(files[0]!)
          : options.loadFiles(files),
    });
  }

  mount(): void {
    for (const panel of this.#panels) panel.mount();
    this.#dropZone.mount();
    this.#bindKeys();

    this.#options.hud.startFpsCounter();
    this.cameraPanel.syncTurntable(this.#options.store.state.autoRotate);
  }

  /** Re-sync the viewer after `loadDocument()` — clips, explode baseline, presets. */
  onDocumentLoaded(): void {
    this.explode.reset();
    this.#options.viewer.syncFromDocument();
    this.animation.refresh();
    this.lighting.sync(this.#options.store.state);
    this.display.sync(this.#options.store.state);
    this.cameraPanel.syncTurntable(this.#options.store.state.autoRotate);
  }

  /** Reflect the loaded preset in the model `<select>` (custom files keep the last option). */
  selectModelOption(value: string | null): void {
    this.model.selectModelOption(value);
  }

  destroy(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.#dropZone.destroy();
    this.#options.camera.stopTurntable();
    for (const panel of this.#panels) panel.destroy();
    this.#options.hud.destroy();
  }

  #bindKeys(): void {
    const { store, camera, hud } = this.#options;

    const off = bindHotkeys({
      ...Object.fromEntries(
        Object.entries(MODE_BY_SHORTCUT).map(([key, mode]) => [
          key,
          () => store.patch({ display: mode }),
        ]),
      ),
      g: () => this.transform.setMode("translate"),
      r: () => this.transform.setMode("rotate"),
      s: () => this.transform.setMode("scale"),
      f: () => camera.frameScene(true),
      h: () => {
        camera.resetCamera(true);
        hud.showToast("Camera Reset [H]");
      },
      "7": () => this.cameraPanel.setPreset("top"),
      space: () => store.patch({ autoRotate: !store.state.autoRotate }),
      p: () => this.animation.togglePlay(),
    });
    this.#disposers.push(off);
  }
}
