import * as THREE from "three";
import { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

/**
 * Camera controller: encapsulates camera animation, framing, turntable logic.
 * Extracted from main.ts so main.ts only handles UI event dispatch.
 */
export class CameraController {
  private readonly el: SceneEditorElement;
  private readonly getRuntime: () => ThreeRuntime | null;

  private cancelled = false;
  private animId: number | null = null;
  private turntableActive = false;
  private lastTurntableTime = 0;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.el = el;
    this.getRuntime = getRuntime;
  }

  flyTo(targetPos: THREE.Vector3, targetLookAt: THREE.Vector3, duration = 320): void {
    this.cancel();

    const curView = this.el.getViewState();
    const startPos = new THREE.Vector3(...curView.camera.position);
    const startTarget = new THREE.Vector3(...curView.camera.target);
    const startTime = performance.now();

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      if (this.cancelled) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = easeOutCubic(progress);

      const pos = new THREE.Vector3().lerpVectors(startPos, targetPos, ease);
      const tgt = new THREE.Vector3().lerpVectors(startTarget, targetLookAt, ease);

      const cur = this.el.getViewState();
      this.el.setViewState({
        ...cur,
        camera: {
          ...cur.camera,
          position: [pos.x, pos.y, pos.z],
          target: [tgt.x, tgt.y, tgt.z],
        },
      });

      if (progress < 1) {
        this.animId = requestAnimationFrame(step);
      } else {
        this.animId = null;
        this.cancelled = false;
      }
    };

    this.animId = requestAnimationFrame(step);
  }

  frameScene(smooth = true): void {
    const { center, distance } = this.getTargetBoundingInfo();

    const targetCamPos = new THREE.Vector3(
      center.x + distance * 0.55,
      center.y + distance * 0.35,
      center.z + distance * 0.65,
    );

    if (smooth) {
      this.flyTo(targetCamPos, center, 320);
    } else {
      const curView = this.el.getViewState();
      this.el.setViewState({
        ...curView,
        camera: {
          ...curView.camera,
          position: [targetCamPos.x, targetCamPos.y, targetCamPos.z],
          target: [center.x, center.y, center.z],
        },
      });
    }
  }

  setCameraPreset(preset: "iso" | "top" | "front" | "side", smooth = true): void {
    const { center, distance } = this.getTargetBoundingInfo();
    let newCamPos: THREE.Vector3;

    if (preset === "iso") {
      newCamPos = new THREE.Vector3(
        center.x + distance * 0.55,
        center.y + distance * 0.4,
        center.z + distance * 0.65,
      );
    } else if (preset === "top") {
      newCamPos = new THREE.Vector3(center.x, center.y + distance, center.z + 0.001);
    } else if (preset === "front") {
      newCamPos = new THREE.Vector3(center.x, center.y, center.z + distance);
    } else if (preset === "side") {
      newCamPos = new THREE.Vector3(center.x + distance, center.y, center.z);
    } else {
      newCamPos = new THREE.Vector3(
        center.x + distance * 0.55,
        center.y + distance * 0.4,
        center.z + distance * 0.65,
      );
    }

    if (smooth) {
      this.flyTo(newCamPos, center, 320);
    } else {
      const curView = this.el.getViewState();
      this.el.setViewState({
        ...curView,
        camera: {
          ...curView.camera,
          position: [newCamPos.x, newCamPos.y, newCamPos.z],
          target: [center.x, center.y, center.z],
        },
      });
    }
  }

  resetCamera(smooth = true): void {
    const { center, distance } = this.getTargetBoundingInfo();
    const defaultPos = new THREE.Vector3(
      center.x + distance * 0.55,
      center.y + distance * 0.4,
      center.z + distance * 0.65,
    );
    if (smooth) {
      this.flyTo(defaultPos, center, 320);
    } else {
      const curView = this.el.getViewState();
      this.el.setViewState({
        ...curView,
        camera: {
          ...curView.camera,
          position: [defaultPos.x, defaultPos.y, defaultPos.z],
          target: [center.x, center.y, center.z],
        },
      });
    }
  }

  getBoundingInfo(): { center: THREE.Vector3; size: THREE.Vector3; distance: number } {
    return this.getTargetBoundingInfo();
  }

  toggleTurntable(): boolean {
    this.turntableActive = !this.turntableActive;

    if (this.turntableActive) {
      this.lastTurntableTime = performance.now();
      const orbitSpeed = 0.45; // rad per second

      const spin = (time: number) => {
        if (!this.turntableActive) return;
        const dt = (time - this.lastTurntableTime) / 1000;
        this.lastTurntableTime = time;

        const rt = this.getRuntime();
        if (rt) {
          const curView = this.el.getViewState();
          const target = new THREE.Vector3(...curView.camera.target);
          const camPos = new THREE.Vector3(...curView.camera.position);

          const rel = camPos.sub(target);
          const angle = orbitSpeed * dt;
          const newX = rel.x * Math.cos(angle) - rel.z * Math.sin(angle);
          const newZ = rel.x * Math.sin(angle) + rel.z * Math.cos(angle);

          this.el.setViewState({
            ...curView,
            camera: {
              ...curView.camera,
              position: [target.x + newX, curView.camera.position[1], target.z + newZ],
            },
          });
        }
        this.animId = requestAnimationFrame(spin);
      };
      this.animId = requestAnimationFrame(spin);
    } else {
      if (this.animId) cancelAnimationFrame(this.animId);
      this.animId = null;
    }

    return this.turntableActive;
  }

  stopTurntable(): void {
    this.turntableActive = false;
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
    this.cancelled = false;
  }

  destroy(): void {
    this.stopTurntable();
    this.cancel();
  }

  private getTargetBoundingInfo(): {
    center: THREE.Vector3;
    size: THREE.Vector3;
    distance: number;
  } {
    const rt = this.getRuntime();
    const curDoc = this.el.getDocument();
    const box = new THREE.Box3();
    let found = false;

    if (rt) {
      for (const objDto of curDoc.objects) {
        const o3d = rt.getObjectById(objDto.id);
        if (o3d) {
          box.expandByObject(o3d);
          found = true;
        }
      }
    }

    if (!found || box.isEmpty()) {
      return {
        center: new THREE.Vector3(0, 1.35, 0),
        size: new THREE.Vector3(1.4, 2.7, 1.1),
        distance: 6.8,
      };
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const fov = (rt?.camera.fov ?? 48) * (Math.PI / 180);

    const distance = Math.max(Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.2, 5.8);

    return { center, size, distance };
  }
}
