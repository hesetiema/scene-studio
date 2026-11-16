import type { SceneEditorElement } from "@scenio/scene-editor/element";
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

/** 与其它滑杆一致：一次拖动写一次文档，多余的事件靠历史协调器合并。 */
const FOV_MIN = 15;
const FOV_MAX = 100;

export interface CameraPanelOptions {
  camera: CameraController;
  hud: HUDController;
  store: ViewerStore;
  el: SceneEditorElement;
}

/**
 * Frame / reset / turntable + camera presets + FOV.
 *
 * The Footer readout lives here because this panel is the only place that knows
 * whether the current pose is still a named preset: `camera-change` fires for
 * every drag frame, so an orbit silently turns "顶视" into "自由" and the label
 * must follow. FOV is written through `setViewState()` — `fov` is part of the
 * document's `view.camera` (D22), so it persists, marks the scene dirty and
 * joins the camera undo scope, unlike the display-only `field-of-view`
 * attribute.
 */
export class CameraPanel extends BasePanel {
  readonly #options: CameraPanelOptions;
  #unsubscribe: (() => void) | null = null;
  /** Current named preset; `null` = the user orbited away or the view was framed. */
  #preset: CameraPreset | null = null;
  /** rAF coalescing: `camera-change` fires once per frame while damping. */
  #readoutRaf: number | null = null;

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

    const fovSlider = document.querySelector<HTMLInputElement>("#fov-slider");
    if (fovSlider) {
      this.listen(fovSlider, "input", () => this.setFieldOfView(Number(fovSlider.value)));
    }

    // Both channels, because a pose can change without being a gesture:
    // `camera-change` covers drag/damping/turntable, `view-change` covers the
    // preset flights and the FOV slider (an `applyViewState` never emits the
    // former). Presets are invalidated by either, except our own writes.
    this.listen(this.#options.el, "camera-change", () => this.#onPoseChanged());
    this.listen(this.#options.el, "view-change", () => this.#scheduleReadout());

    this.#unsubscribe = this.#options.store.subscribe((next) => {
      this.syncTurntable(next.autoRotate);
    });
    this.syncTurntable(this.#options.store.state.autoRotate);
    this.syncAfterLoad();
  }

  setPreset(preset: CameraPreset): void {
    this.#preset = preset;
    this.#options.camera.setCameraPreset(preset, true);

    for (const [id, selector] of Object.entries(PRESET_BUTTONS)) {
      this.syncActive(selector, id === preset);
    }
    this.#options.hud.showToast(`视角：${PRESET_LABELS[preset]}`);
    this.#scheduleReadout();
  }

  /** New document: the automatic fit is not a preset, and FOV comes from the doc. */
  syncAfterLoad(): void {
    this.#preset = null;
    for (const selector of Object.values(PRESET_BUTTONS)) this.syncActive(selector, false);
    this.#syncFovSlider();
    this.refreshReadout();
  }

  /**
   * Vertical FOV in degrees, written to the document. Clamped to the slider's
   * own range so a document with an extreme value cannot desync the control.
   */
  setFieldOfView(degrees: number): void {
    const el = this.#options.el;
    const fov = Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(degrees)));
    const view = el.getViewState();
    el.setViewState({ ...view, camera: { ...view.camera, fov } });
    this.syncText("#fov-val", `${fov}°`);
    this.#scheduleReadout();
  }

  syncTurntable(active: boolean): void {
    this.syncActive("#btn-turntable", active);
  }

  /** `视角 顶视 · FOV 48° · 距离 6.8` — every number read live, none hardcoded. */
  refreshReadout(): void {
    const el = this.#options.el;
    const label = this.#preset ? PRESET_LABELS[this.#preset] : "自由";

    let fov = "";
    let distance = "";
    try {
      const orbit = el.getCameraOrbit();
      fov = `FOV ${Math.round(el.getFieldOfView())}°`;
      if (orbit) distance = `距离 ${orbit.radius.toFixed(1)}`;
    } catch {
      // Before the first document / controls: the label is still honest.
    }

    const parts = [`视角 ${label}`, fov, distance].filter(Boolean);
    this.syncText("#hud-cam-stat", parts.join(" · "));
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#readoutRaf !== null) cancelAnimationFrame(this.#readoutRaf);
    this.#readoutRaf = null;
  }

  #onPoseChanged(): void {
    // A drag, a damped settle or the turntable moved the camera: whatever
    // preset was active no longer describes the view.
    if (this.#preset) {
      this.#preset = null;
      for (const selector of Object.values(PRESET_BUTTONS)) this.syncActive(selector, false);
    }
    this.#scheduleReadout();
  }

  #scheduleReadout(): void {
    if (this.#readoutRaf !== null) return;
    this.#readoutRaf = requestAnimationFrame(() => {
      this.#readoutRaf = null;
      this.#syncFovSlider();
      this.refreshReadout();
    });
  }

  /** Follow the document's FOV (a load, or an undo of a previous slider drag). */
  #syncFovSlider(): void {
    const slider = document.querySelector<HTMLInputElement>("#fov-slider");
    if (!slider) return;
    try {
      const fov = Math.round(this.#options.el.getFieldOfView());
      if (document.activeElement !== slider) slider.value = String(fov);
      this.syncText("#fov-val", `${fov}°`);
    } catch {
      // No document yet.
    }
  }
}
