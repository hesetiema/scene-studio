import * as THREE from "three";
import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export type CameraPreset = "iso" | "top" | "front" | "side";

interface BoundingInfo {
  center: THREE.Vector3;
  size: THREE.Vector3;
  /** 包围球半径。SDK 的 `#render()` 用它自适应近/远裁剪面。 */
  radius: number;
  /** 让整颗包围球落在视野内的相机距离（水平/垂直取更紧的一侧）。 */
  distance: number;
}

/** SDK `smoothViewTo` 的衰减常数（≈ 95% 位移走完的时长）。 */
const FLY_DECAY_MS = 240;
/** 取景留白：1 = 刚好贴边。 */
const FIT_PADDING = 1.1;

const EMPTY_BOUNDS = {
  center: new THREE.Vector3(0, 1.35, 0),
  size: new THREE.Vector3(1.4, 2.7, 1.1),
  radius: 1.6,
  distance: 6.8,
};

/**
 * Camera controller: framing and presets.
 *
 * Framing is model-driven: the fit distance comes from the bounding sphere and
 * the *smaller* of the horizontal/vertical FOV, so a wide model in a narrow
 * viewport still fits. Clip planes and the flight easing are the SDK's:
 * `render()` re-derives near/far per frame, and `smoothViewTo()` owns the
 * decay, the reduced-motion landing and the fade-vs-drag handoff.
 *
 * Perf note (D22): preview frames drive `runtime.applyViewState()`, which renders
 * without emitting `view-change`. The document is written exactly once when the
 * gesture ends — otherwise a 300ms fly-to would fire ~18 view-change events and
 * dirty marks instead of one.
 */
export class CameraController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  /** Pending "flight settled → commit" timer (`setTimeout` id). */
  #settleTimer: number | null = null;
  #boundsCache: BoundingInfo | null = null;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  /** Drop the cached bounds — call after a document load. */
  invalidateBounds(): void {
    this.#boundsCache = null;
  }

  /**
   * Ease the camera to a pose. The SDK owns the fade; `getViewState()` reads
   * the *live* camera, so the commit cannot ride along — it lands after the
   * asymptote (the fade is ~done at 2.5× the decay constant).
   */
  flyTo(
    position: THREE.Vector3,
    target: THREE.Vector3,
    duration = FLY_DECAY_MS,
    commit = true,
  ): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    this.#cancelSettle();

    const view = rt.getViewState();
    rt.smoothViewTo({
      ...view.camera,
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
    }, duration);

    if (commit) {
      this.#settleTimer = window.setTimeout(
        () => this.#commit(),
        Math.ceil(duration * 2.5),
      );
    }
  }

  /**
   * Center & fit the whole scene, keeping the familiar 3/4 view direction.
   * `commit: false` only moves the camera — the document stays untouched, so an
   * automatic fit on open does not mark the scene as modified.
   */
  frameScene(smooth = true, commit = true): void {
    this.#frameFrom(new THREE.Vector3(0.55, 0.35, 0.65), smooth, commit);
  }

  setCameraPreset(preset: CameraPreset, smooth = true): void {
    const directions: Record<CameraPreset, THREE.Vector3> = {
      // A hair of Z keeps the up-vector stable straight overhead.
      top: new THREE.Vector3(0, 1, 0.0015),
      front: new THREE.Vector3(0, 0, 1),
      side: new THREE.Vector3(1, 0, 0),
      iso: new THREE.Vector3(0.55, 0.4, 0.65),
    };
    this.#frameFrom(directions[preset], smooth, true);
  }

  resetCamera(smooth = true): void {
    this.#frameFrom(new THREE.Vector3(0.55, 0.4, 0.65), smooth, true);
  }

  getBoundingInfo(): BoundingInfo {
    return this.#bounds();
  }

  destroy(): void {
    this.#cancelSettle();
  }

  /** Place the camera at `distance` from the scene center along `direction`. */
  #frameFrom(direction: THREE.Vector3, smooth: boolean, commit: boolean): void {
    // Framing is a user-visible action, so it re-measures (an object may have
    // been dragged far away); the SDK re-derives clip planes on every render.
    const { center, distance } = this.#bounds(true);
    const offset = direction.normalize().multiplyScalar(distance);
    this.#moveTo(center.clone().add(offset), center, smooth, commit);
  }

  #moveTo(
    position: THREE.Vector3,
    target: THREE.Vector3,
    smooth: boolean,
    commit: boolean,
  ): void {
    if (smooth) {
      this.flyTo(position, target, FLY_DECAY_MS, commit);
      return;
    }
    const rt = this.#getRuntime();
    if (!rt) return;
    const view = rt.getViewState();
    this.#preview({
      ...view,
      camera: {
        ...view.camera,
        position: [position.x, position.y, position.z],
        target: [target.x, target.y, target.z],
      },
    });
    if (commit) this.#commit();
  }

  #preview(view: ViewState): void {
    this.#getRuntime()?.applyViewState(view);
  }

  #commit(): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    this.#el.setViewState(rt.getViewState());
  }

  #cancelSettle(): void {
    if (this.#settleTimer !== null) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
  }

  #bounds(refresh = false): BoundingInfo {
    if (!refresh && this.#boundsCache) return this.#boundsCache;

    const rt = this.#getRuntime();
    const doc = this.#el.getDocument();
    const box = new THREE.Box3();

    if (rt) {
      for (const dto of doc.objects) {
        const obj = rt.getObjectById(dto.id);
        if (obj) box.expandByObject(obj);
      }
    }

    if (box.isEmpty()) {
      this.#boundsCache = {
        center: EMPTY_BOUNDS.center.clone(),
        size: EMPTY_BOUNDS.size.clone(),
        radius: EMPTY_BOUNDS.radius,
        distance: EMPTY_BOUNDS.distance,
      };
      return this.#boundsCache;
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.001);

    // Fit the bounding sphere: with orbiting, the sphere (not the AABB) is what
    // must stay inside the frustum. The narrower FOV decides the distance.
    const fov = ((rt?.camera.fov ?? 48) * Math.PI) / 180;
    const aspect = rt && rt.camera.aspect > 0 ? rt.camera.aspect : 1;
    const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const limitingFov = Math.max(Math.min(fov, hFov), 0.01);
    const distance = Math.max((radius / Math.sin(limitingFov / 2)) * FIT_PADDING, 0.5);

    this.#boundsCache = { center, size, radius, distance };
    return this.#boundsCache;
  }
}
