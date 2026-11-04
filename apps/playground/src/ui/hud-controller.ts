import { inspectModel } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import * as THREE from "three";

/**
 * HUD controller: encapsulates all DOM updates for the right panel (telemetry,
 * dirty state, selection inspector), bottom toast, and FPS counter.
 * Extracted from main.ts so main.ts only wires events.
 */
export class HUDController {
  private readonly el: SceneEditorElement;
  private readonly getRuntime: () => ThreeRuntime | null;

  private frameCount = 0;
  private lastFpsTime = performance.now();
  private fpsRafId: number | null = null;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.el = el;
    this.getRuntime = getRuntime;
  }

  /** Update bottom-bar revision / dirty / object count. */
  updateDirtyUI(): void {
    const revEl = document.querySelector("#rev-val");
    const dirtyEl = document.querySelector("#dirty-val");
    const objCountEl = document.querySelector("#obj-count-val");

    if (revEl) revEl.textContent = String(this.el.revision);
    if (dirtyEl) {
      dirtyEl.textContent = this.el.dirty ? "已修改" : "未修改";
      (dirtyEl as HTMLElement).style.color = this.el.dirty ? "#e0b25c" : "#8fbfd8";
    }
    if (objCountEl) objCountEl.textContent = String(this.el.getDocument().objects.length);
  }

  /** Show a transient toast message (bottom center). */
  showToast(msg: string): void {
    const toast = document.querySelector("#toast") as HTMLElement | null;
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 2500);
  }

  /** Update right-panel telemetry (name, format, mesh/poly/vert counts, bounds). */
  updateTelemetry(name: string, format: string): void {
    const nameEl = document.querySelector("#stat-name");
    const formatEl = document.querySelector("#stat-format");
    const meshEl = document.querySelector("#stat-meshes");
    const polyEl = document.querySelector("#stat-polys");
    const vertEl = document.querySelector("#stat-verts");
    const boundEl = document.querySelector("#stat-bounds");

    if (nameEl) nameEl.textContent = name;
    if (formatEl) formatEl.textContent = format.toUpperCase();

    const rt = this.getRuntime();
    if (!rt) return;

    const currentDoc = this.el.getDocument();
    let totalMeshes = 0;
    let totalTris = 0;
    let totalVerts = 0;
    const overallBox = new THREE.Box3();

    for (const objDto of currentDoc.objects) {
      const obj3d = rt.getObjectById(objDto.id);
      if (obj3d) {
        const meta = inspectModel(obj3d);
        totalMeshes += meta.meshCount;
        totalTris += meta.triangleCount;
        totalVerts += meta.vertexCount;
        overallBox.expandByObject(obj3d);
      }
    }

    const size = overallBox.getSize(new THREE.Vector3());

    if (meshEl) meshEl.textContent = totalMeshes.toLocaleString();
    if (polyEl) polyEl.textContent = totalTris.toLocaleString();
    if (vertEl) vertEl.textContent = totalVerts.toLocaleString();
    if (boundEl) {
      boundEl.textContent = `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}m`;
    }
  }

  /** Update selection inspector (id, position, rotation in degrees). */
  updateSelectionUI(): void {
    const idEl = document.querySelector("#inspect-id");
    const posEl = document.querySelector("#inspect-pos");
    const rotEl = document.querySelector("#inspect-rot");

    const selectedId = this.el.selectedIds[0];
    if (!selectedId) {
      if (idEl) idEl.textContent = "未选择（点击模型）";
      if (posEl) posEl.textContent = "[0.00, 0.00, 0.00]";
      if (rotEl) rotEl.textContent = "[0°, 0°, 0°]";
      return;
    }

    const doc = this.el.getDocument();
    const obj = doc.objects.find((o) => o.id === selectedId);
    if (!obj) return;

    if (idEl) idEl.textContent = obj.name || obj.id;
    if (posEl) {
      posEl.textContent = `[${obj.position[0].toFixed(2)}, ${obj.position[1].toFixed(2)}, ${obj.position[2].toFixed(2)}]`;
    }
    if (rotEl) {
      const degX = ((obj.rotation[0] * 180) / Math.PI).toFixed(0);
      const degY = ((obj.rotation[1] * 180) / Math.PI).toFixed(0);
      const degZ = ((obj.rotation[2] * 180) / Math.PI).toFixed(0);
      rotEl.textContent = `[${degX}°, ${degY}°, ${degZ}°]`;
    }
  }

  /** Start FPS & latency counter (top HUD). Call once during UI setup. */
  startFpsCounter(): void {
    const fpsEl = document.querySelector("#hud-perf-stat");

    const tick = (now: number) => {
      this.frameCount++;
      if (now - this.lastFpsTime >= 500) {
        const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
        const ms = (1000 / Math.max(fps, 1)).toFixed(1);
        if (fpsEl) fpsEl.textContent = `FPS ${fps} · ${ms}ms`;
        this.frameCount = 0;
        this.lastFpsTime = now;
      }
      this.fpsRafId = requestAnimationFrame(tick);
    };
    this.fpsRafId = requestAnimationFrame(tick);
  }

  /** Stop FPS counter (cleanup). */
  destroy(): void {
    if (this.fpsRafId) cancelAnimationFrame(this.fpsRafId);
    this.fpsRafId = null;
  }
}
