import type { CameraController, CameraPreset } from "../../camera/camera-controller";
import type { ViewerStore } from "../../viewer/viewer-state";
import type { HUDController } from "../hud-controller";
import { BasePanel } from "../panel";

const PRESET_BUTTONS: Record<CameraPreset, string> = {
  iso: "#cam-iso",
  top: "#cam-top",
  front: "#cam-front",
  side: "#cam-side",
};

const PRESET_LABELS: Record<CameraPreset, string> = {
  iso: "等轴",
  top: "顶视",
  front: "前视",
  side: "侧视",
};

export interface CameraPanelOptions {
  camera: CameraController;
  hud: HUDController;
  store: ViewerStore;
}

/** Frame / reset / turntable + camera presets. */
export class CameraPanel extends BasePanel {
  readonly #options: CameraPanelOptions;
  #unsubscribe: (() => void) | null = null;

  constructor(options: CameraPanelOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.click("#btn-frame", () => {
      this.#options.camera.frameScene(true);
      this.#options.hud.showToast("已聚焦模型");
    });

    this.click("#btn-reset-cam", () => {
      this.#options.camera.resetCamera(true);
      this.#options.hud.showToast("相机已复位 [H]");
    });

    // State-driven: ViewerController owns the actual turntable toggle.
    this.click("#btn-turntable", () => {
      this.#options.store.patch({ autoRotate: !this.#options.store.state.autoRotate });
    });

    for (const [preset, selector] of Object.entries(PRESET_BUTTONS)) {
      this.click(selector, () => this.setPreset(preset as CameraPreset));
    }

    this.#unsubscribe = this.#options.store.subscribe((next) => {
      this.syncTurntable(next.autoRotate);
    });
    this.syncTurntable(this.#options.store.state.autoRotate);
  }

  setPreset(preset: CameraPreset): void {
    this.#options.camera.setCameraPreset(preset, true);

    const { distance } = this.#options.camera.getBoundingInfo();
    this.syncText("#hud-cam-stat", `相机 ${PRESET_LABELS[preset]} · 距离 ${distance.toFixed(1)}`);

    for (const [id, selector] of Object.entries(PRESET_BUTTONS)) {
      this.syncActive(selector, id === preset);
    }
    this.#options.hud.showToast(`视角：${PRESET_LABELS[preset]}`);
  }

  syncTurntable(active: boolean): void {
    this.syncActive("#btn-turntable", active);
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
