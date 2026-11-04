import * as THREE from "three";
import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export type CameraPreset = "iso" | "top" | "front" | "side";

interface BoundingInfo {
  center: THREE.Vector3;
  size: THREE.Vector3;
  /** 包围球半径。近/远裁剪面按它自适应，避免放大缩小时模型被裁掉。 */
  radius: number;
  /** 让整颗包围球落在视野内的相机距离（水平/垂直取更紧的一侧）。 */
  distance: number;
}

const TURNTABLE_SPEED = 0.45; // rad / second
const FLY_DURATION = 320; // ms
/** 取景留白：1 = 刚好贴边。 */
const FIT_PADDING = 1.1;

const EMPTY_BOUNDS = {
  center: new THREE.Vector3(0, 1.35, 0),
  size: new THREE.Vector3(1.4, 2.7, 1.1),
  radius: 1.6,
  distance: 6.8,
};

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Camera controller: framing, presets and turntable.
 *
 * Framing is model-driven: the fit distance comes from the bounding sphere and
 * the *smaller* of the horizontal/vertical FOV, so a wide model in a narrow
 * viewport still fits. Clip planes follow the live camera distance because
 * imported assets range from millimetres to hundreds of metres.
 *
 * Perf note (D22): preview frames drive `runtime.applyViewState()`, which renders
 * without emitting `view-change`. The document is written exactly once when the
 * gesture ends — otherwise a 300ms fly-to would fire ~18 view-change events and
 * dirty marks instead of one.
 */
export class CameraController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  #flyRaf: number | null = null;
  #turntableRaf: number | null = null;
  #clipRaf: number | null = null;
  #turntableActive = false;
  #lastTurntableTime = 0;
  #boundsCache: BoundingInfo | null = null;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  get turntableActive(): boolean {
    return this.#turntableActive;
  }

  /** Drop the cached bounds — call after a document load. */
  invalidateBounds(): void {
    this.#boundsCache = null;
  }

  /**
   * Keep near/far in sync with the live camera distance (every frame).
   * OrbitControls mutates the camera directly, so there is no event to hook that
   * would cover wheel zoom without this ticker.
   */
  startClipSync(): void {
    if (this.#clipRaf !== null) return;
    const tick = (): void => {
      this.syncClipPlanes();
      this.#clipRaf = requestAnimationFrame(tick);
    };
    this.#clipRaf = requestAnimationFrame(tick);
  }

  stopClipSync(): void {
    if (this.#clipRaf === null) return;
    cancelAnimationFrame(this.#clipRaf);
    this.#clipRaf = null;
  }

  /** Re-derive near/far from camera distance + model radius. Cheap when unchanged. */
  syncClipPlanes(): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    const { radius } = this.#bounds();
    const { position, target } = rt.getViewState().camera;
    const distance = Math.hypot(
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    );

    const near = Math.max(distance * 0.002, radius * 0.0005, 0.0005);
    const far = Math.max(distance * 4 + radius * 8, near * 100);

    const camera = rt.camera;
    const nearDrifted = Math.abs(camera.near - near) > near * 0.05;
    const farDrifted = Math.abs(camera.far - far) > far * 0.05;
    if (!nearDrifted && !farDrifted) return;

    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
    rt.render();
  }

  flyTo(
    position: THREE.Vector3,
    target: THREE.Vector3,
    duration = FLY_DURATION,
    commit = true,
  ): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    this.stopFly();

    const start = rt.getViewState();
    const from = new THREE.Vector3(...start.camera.position);
    const lookAt = new THREE.Vector3(...start.camera.target);
    const startedAt = performance.now();

    const step = (now: number): void => {
      const progress = duration <= 0 ? 1 : Math.min((now - startedAt) / duration, 1);
      const ease = easeOutCubic(progress);

      this.#preview({
        ...start,
        camera: {
          ...start.camera,
          position: [
            THREE.MathUtils.lerp(from.x, position.x, ease),
            THREE.MathUtils.lerp(from.y, position.y, ease),
            THREE.MathUtils.lerp(from.z, position.z, ease),
          ],
          target: [
            THREE.MathUtils.lerp(lookAt.x, target.x, ease),
            THREE.MathUtils.lerp(lookAt.y, target.y, ease),
            THREE.MathUtils.lerp(lookAt.z, target.z, ease),
          ],
        },
      });

      if (progress < 1) {
        this.#flyRaf = requestAnimationFrame(step);
        return;
      }
      this.#flyRaf = null;
      if (commit) this.#commit();
    };

    this.#flyRaf = requestAnimationFrame(step);
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

  /** Returns the new active state. Commits the document once when stopping. */
  toggleTurntable(): boolean {
    if (this.#turntableActive) {
      this.stopTurntable();
      return false;
    }

    const rt = this.#getRuntime();
    if (!rt) return false;

    this.stopFly();
    this.#turntableActive = true;
    this.#lastTurntableTime = performance.now();

    const spin = (now: number): void => {
      if (!this.#turntableActive) return;
      const runtime = this.#getRuntime();
      // Cap dt so a backgrounded tab does not teleport the camera.
      const dt = Math.min((now - this.#lastTurntableTime) / 1000, 0.1);
      this.#lastTurntableTime = now;

      if (runtime) {
        const view = runtime.getViewState();
        const [tx, ty, tz] = view.camera.target;
        const [px, , pz] = view.camera.position;
        const dx = px - tx;
        const dz = pz - tz;
        const angle = TURNTABLE_SPEED * dt;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.#preview({
          ...view,
          camera: {
            ...view.camera,
            position: [tx + dx * cos - dz * sin, view.camera.position[1], tz + dx * sin + dz * cos],
          },
        });
      }
      this.#turntableRaf = requestAnimationFrame(spin);
    };

    this.#turntableRaf = requestAnimationFrame(spin);
    return true;
  }

  stopTurntable(): void {
    if (!this.#turntableActive) return;
    this.#turntableActive = false;
    if (this.#turntableRaf !== null) {
      cancelAnimationFrame(this.#turntableRaf);
      this.#turntableRaf = null;
    }
    this.#commit();
  }

  stopFly(): void {
    if (this.#flyRaf !== null) {
      cancelAnimationFrame(this.#flyRaf);
      this.#flyRaf = null;
    }
  }

  destroy(): void {
    this.stopFly();
    this.stopClipSync();
    this.#turntableActive = false;
    if (this.#turntableRaf !== null) {
      cancelAnimationFrame(this.#turntableRaf);
      this.#turntableRaf = null;
    }
  }

  /** Place the camera at `distance` from the scene center along `direction`. */
  #frameFrom(direction: THREE.Vector3, smooth: boolean, commit: boolean): void {
    // Framing is a user-visible action, so it re-measures (an object may have
    // been dragged far away); the per-frame clip sync reuses the cached result.
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
      this.flyTo(position, target, FLY_DURATION, commit);
      return;
    }
    const rt = this.#getRuntime();
    if (!rt) return;
    this.stopFly();
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
    this.syncClipPlanes();
  }

  #preview(view: ViewState): void {
    this.#getRuntime()?.applyViewState(view);
  }

  #commit(): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    this.#el.setViewState(rt.getViewState());
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
