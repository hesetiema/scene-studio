import * as THREE from "three";
import type { ViewState } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export type CameraPreset = "iso" | "top" | "front" | "side";

interface BoundingInfo {
  center: THREE.Vector3;
  size: THREE.Vector3;
  distance: number;
}

const TURNTABLE_SPEED = 0.45; // rad / second
const FLY_DURATION = 320; // ms

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Camera controller: framing, presets and turntable.
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
  #turntableActive = false;
  #lastTurntableTime = 0;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  get turntableActive(): boolean {
    return this.#turntableActive;
  }

  flyTo(position: THREE.Vector3, target: THREE.Vector3, duration = FLY_DURATION): void {
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
      this.#commit();
    };

    this.#flyRaf = requestAnimationFrame(step);
  }

  frameScene(smooth = true): void {
    const { center, distance } = this.#bounds();
    this.#moveTo(
      new THREE.Vector3(
        center.x + distance * 0.55,
        center.y + distance * 0.35,
        center.z + distance * 0.65,
      ),
      center,
      smooth,
    );
  }

  setCameraPreset(preset: CameraPreset, smooth = true): void {
    const { center, distance } = this.#bounds();
    const position =
      preset === "top"
        ? new THREE.Vector3(center.x, center.y + distance, center.z + 0.001)
        : preset === "front"
          ? new THREE.Vector3(center.x, center.y, center.z + distance)
          : preset === "side"
            ? new THREE.Vector3(center.x + distance, center.y, center.z)
            : new THREE.Vector3(
                center.x + distance * 0.55,
                center.y + distance * 0.4,
                center.z + distance * 0.65,
              );
    this.#moveTo(position, center, smooth);
  }

  resetCamera(smooth = true): void {
    const { center, distance } = this.#bounds();
    this.#moveTo(
      new THREE.Vector3(
        center.x + distance * 0.55,
        center.y + distance * 0.4,
        center.z + distance * 0.65,
      ),
      center,
      smooth,
    );
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
    this.#turntableActive = false;
    if (this.#turntableRaf !== null) {
      cancelAnimationFrame(this.#turntableRaf);
      this.#turntableRaf = null;
    }
  }

  #moveTo(position: THREE.Vector3, target: THREE.Vector3, smooth: boolean): void {
    if (smooth) {
      this.flyTo(position, target);
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
    this.#commit();
  }

  #preview(view: ViewState): void {
    this.#getRuntime()?.applyViewState(view);
  }

  #commit(): void {
    const rt = this.#getRuntime();
    if (!rt) return;
    this.#el.setViewState(rt.getViewState());
  }

  #bounds(): BoundingInfo {
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
      return {
        center: new THREE.Vector3(0, 1.35, 0),
        size: new THREE.Vector3(1.4, 2.7, 1.1),
        distance: 6.8,
      };
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const fov = ((rt?.camera.fov ?? 48) * Math.PI) / 180;
    const distance = Math.max(Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.2, 5.8);

    return { center, size, distance };
  }
}
