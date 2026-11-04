import * as THREE from "three";
import type { AnimationClipInfo, ThreeRuntime } from "@scenio/scene-editor/three";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { CameraController } from "../camera/camera-controller";
import { createDisplayModes, type DisplayModes } from "./display-modes";
import {
  DEFAULT_BACKDROP,
  LIGHTING_PRESETS,
  applyBackdrop,
  applyLightingPreset,
  readDocumentView,
  setGridVisible,
} from "./presets";
import type { ToneMappingId, ViewerState, ViewerStore } from "./viewer-state";

const TONE_MAPPING: Record<ToneMappingId, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  aces: THREE.ACESFilmicToneMapping,
};

export interface ViewerControllerOptions {
  store: ViewerStore;
  el: SceneEditorElement;
  getRuntime: () => ThreeRuntime | null;
  camera: CameraController;
}

/**
 * Translates viewer state → engine calls (reference: `Viewer#update*`).
 *
 * One state change maps to exactly one update path; panels stay declarative and
 * never reach into ThreeRuntime themselves.
 */
export class ViewerController {
  readonly #store: ViewerStore;
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;
  readonly #camera: CameraController;
  readonly #display: DisplayModes;

  #unsubscribe: (() => void) | null = null;
  #skeleton: THREE.SkeletonHelper[] = [];
  #followRaf: number | null = null;

  constructor(options: ViewerControllerOptions) {
    this.#store = options.store;
    this.#el = options.el;
    this.#getRuntime = options.getRuntime;
    this.#camera = options.camera;
    this.#display = createDisplayModes(options.el, options.getRuntime);
  }

  mount(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#store.subscribe((next, prev) => this.#handle(next, prev));
    this.#applyRenderSettings(this.#store.state);
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#stopLightFollow();
    this.#clearSkeleton();
    this.#display.dispose();
  }

  /** Refresh document-owned slices after `loadDocument()` and re-apply previews. */
  syncFromDocument(): void {
    const view = readDocumentView(this.#el);
    const clips = this.animations;
    const first = clips[0];

    this.#store.syncFromDocument({
      background: view?.environment.background ?? DEFAULT_BACKDROP,
      grid: view?.environment.gridVisible ?? true,
      animation: first
        ? { clipId: first.id, playing: true, speed: this.#store.state.animation.speed }
        : { clipId: null, playing: false },
    });

    this.#display.reset(this.#store.state.display);
    this.#applyRenderSettings(this.#store.state);
    // 强度的倍率与颜色覆盖是预览态，换文档后需要重新叠加到新文档的灯光上。
    this.#applyLightTuning(this.#store.state);

    this.#clearSkeleton();
    if (this.#store.state.skeleton) this.#applySkeleton(true);

    if (first) {
      const rt = this.#getRuntime();
      rt?.playAnimation(first.objectId, first.index);
    } else {
      this.#getRuntime()?.pauseAnimations();
    }
  }

  // -------------------------------------------------------------------------
  // Read surface for panels
  // -------------------------------------------------------------------------

  get animations(): AnimationClipInfo[] {
    return this.#getRuntime()?.animations ?? [];
  }

  get animationTime(): number {
    return this.#getRuntime()?.animationTime ?? 0;
  }

  get animationDuration(): number {
    return this.#getRuntime()?.animationDuration ?? 0;
  }

  /** Play an explicit clip (`${objectId}#${index}`) from the start. */
  playClip(clipId: string): void {
    const target = parseClipId(clipId);
    const rt = this.#getRuntime();
    if (!target || !rt) return;
    rt.setAnimationSpeed(this.#store.state.animation.speed);
    rt.playAnimation(target.objectId, target.index);
  }

  // -------------------------------------------------------------------------
  // update* (state → engine)
  // -------------------------------------------------------------------------

  #handle(next: ViewerState, prev: ViewerState): void {
    if (next.display !== prev.display) this.#display.apply(next.display);
    if (next.skeleton !== prev.skeleton) this.#applySkeleton(next.skeleton);

    if (next.background !== prev.background) applyBackdrop(this.#el, next.background);
    if (next.grid !== prev.grid) setGridVisible(this.#el, next.grid);
    if (next.lighting !== prev.lighting) applyLightingPreset(this.#el, next.lighting);

    if (
      next.lighting !== prev.lighting ||
      next.ambientScale !== prev.ambientScale ||
      next.directionalScale !== prev.directionalScale ||
      next.ambientColor !== prev.ambientColor ||
      next.directionalColor !== prev.directionalColor
    ) {
      this.#applyLightTuning(next);
    }

    if (next.followCamera !== prev.followCamera) this.#applyLightFollow(next.followCamera);

    if (next.exposure !== prev.exposure || next.toneMapping !== prev.toneMapping) {
      this.#applyRenderSettings(next);
    }

    if (next.autoRotate !== prev.autoRotate) this.#applyTurntable(next.autoRotate);

    if (
      next.animation.clipId !== prev.animation.clipId ||
      next.animation.playing !== prev.animation.playing ||
      next.animation.speed !== prev.animation.speed
    ) {
      this.#applyAnimation(next, prev);
    }
  }

  #applyRenderSettings(state: ViewerState): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    const renderer = rt.renderer as unknown as {
      toneMapping?: THREE.ToneMapping;
      toneMappingExposure?: number;
    };
    if ("toneMapping" in renderer) renderer.toneMapping = TONE_MAPPING[state.toneMapping];
    if ("toneMappingExposure" in renderer) renderer.toneMappingExposure = state.exposure;

    // Shader programs are keyed by tone mapping — force a relink.
    rt.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material) material.needsUpdate = true;
      }
    });
    rt.render();
  }

  /**
   * 环境光/主光的强度倍率与颜色覆盖：只写运行时视图，不改文档，
   * 所以调参数不会把场景标脏（与曝光、色调映射一致）。
   */
  #applyLightTuning(state: ViewerState): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    const preset = LIGHTING_PRESETS[state.lighting];
    rt.applyViewState({
      ...rt.getViewState(),
      lights: {
        ambient: {
          color: state.ambientColor ?? preset.ambient.color,
          intensity: preset.ambient.intensity * state.ambientScale,
        },
        directional: {
          color: state.directionalColor ?? preset.directional.color,
          intensity: preset.directional.intensity * state.directionalScale,
          position: [...preset.directional.position],
        },
      },
    });
  }

  #applyLightFollow(active: boolean): void {
    if (active) {
      this.#startLightFollow();
      return;
    }
    this.#stopLightFollow();
    this.#applyLightTuning(this.#store.state);
  }

  /** 主光贴在相机位置上，方向指向观察目标 —— 相当于「头灯」。 */
  #startLightFollow(): void {
    if (this.#followRaf !== null) return;

    const tick = (): void => {
      const rt = this.#getRuntime();
      if (!rt) {
        this.#followRaf = null;
        return;
      }

      // 相机没动就不重绘，避免挂在 rAF 上持续烧 GPU。
      const light = findDirectionalLight(rt.scene);
      if (light && !light.position.equals(rt.camera.position)) {
        light.position.copy(rt.camera.position);
        const [tx, ty, tz] = rt.getViewState().camera.target;
        light.target.position.set(tx, ty, tz);
        light.target.updateMatrixWorld();
        rt.render();
      }

      this.#followRaf = requestAnimationFrame(tick);
    };
    this.#followRaf = requestAnimationFrame(tick);
  }

  #stopLightFollow(): void {
    if (this.#followRaf === null) return;
    cancelAnimationFrame(this.#followRaf);
    this.#followRaf = null;
  }

  #applyTurntable(active: boolean): void {
    if (active === this.#camera.turntableActive) return;
    this.#camera.toggleTurntable();
  }

  #applyAnimation(next: ViewerState, prev: ViewerState): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    if (next.animation.speed !== prev.animation.speed) {
      rt.setAnimationSpeed(next.animation.speed);
    }

    if (next.animation.clipId !== prev.animation.clipId) {
      if (!next.animation.clipId) {
        rt.pauseAnimations();
        return;
      }
      const target = parseClipId(next.animation.clipId);
      if (!target) return;
      rt.setAnimationSpeed(next.animation.speed);
      rt.playAnimation(target.objectId, target.index);
      return;
    }

    if (next.animation.playing !== prev.animation.playing) {
      if (!next.animation.playing) {
        rt.pauseAnimations();
        return;
      }
      if (rt.resumeAnimations()) return;
      const target = parseClipId(next.animation.clipId);
      if (target) rt.playAnimation(target.objectId, target.index);
    }
  }

  #applySkeleton(enabled: boolean): void {
    this.#clearSkeleton();
    const rt = this.#getRuntime();
    if (!rt || !enabled) {
      rt?.render();
      return;
    }

    let objects: readonly { id: string }[] = [];
    try {
      objects = this.#el.getDocument().objects;
    } catch {
      return;
    }

    for (const dto of objects) {
      const root = rt.getObjectById(dto.id);
      if (!root) continue;
      root.traverse((child) => {
        if ((child as THREE.SkinnedMesh).isSkinnedMesh !== true) return;
        const helper = new THREE.SkeletonHelper(child);
        helper.name = "skeleton-helper";
        rt.scene.add(helper);
        this.#skeleton.push(helper);
      });
    }
    rt.render();
  }

  #clearSkeleton(): void {
    for (const helper of this.#skeleton) {
      helper.parent?.remove(helper);
      helper.geometry.dispose();
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      for (const material of materials) material.dispose();
    }
    this.#skeleton = [];
  }
}

function findDirectionalLight(scene: THREE.Scene): THREE.DirectionalLight | null {
  for (const child of scene.children) {
    if ((child as THREE.DirectionalLight).isDirectionalLight) {
      return child as THREE.DirectionalLight;
    }
  }
  return null;
}

function parseClipId(clipId: string | null): { objectId: string; index: number } | null {
  if (!clipId) return null;
  const separator = clipId.lastIndexOf("#");
  if (separator < 0) return null;
  const objectId = clipId.slice(0, separator);
  const index = Number(clipId.slice(separator + 1));
  if (!objectId || !Number.isInteger(index) || index < 0) return null;
  return { objectId, index };
}
