import { inspectModel } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import * as THREE from "three";

/**
 * HUD controller: encapsulates all DOM updates for the right panel (telemetry,
 * sync state, selection inspector), bottom toast, FPS counter and the static
 * build stamp.
 * Extracted from main.ts so main.ts only wires events.
 */
export class HUDController {
  private readonly el: SceneEditorElement;
  private readonly getRuntime: () => ThreeRuntime | null;

  private frameCount = 0;
  private lastFpsTime = performance.now();
  private fpsRafId: number | null = null;
  /** Unresolved save conflict, if any (`remote` = the server's revision). */
  private conflict: { local: number; remote: number } | null = null;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.el = el;
    this.getRuntime = getRuntime;
  }

  /**
   * Bottom-bar sync state. The revision alone is meaningless to a visitor, so
   * the three states share one slot instead of two:
   * `已保存 r3` / `r3 · 未保存改动` / `冲突 · 本地 r4 / 远端 r5`.
   */
  updateDocumentState(): void {
    const syncEl = document.querySelector<HTMLElement>("#sync-val");
    const objectsEl = document.querySelector("#stat-objects");

    if (objectsEl) {
      try {
        objectsEl.textContent = String(this.el.getDocument().objects.length);
      } catch {
        objectsEl.textContent = "--";
      }
    }
    if (!syncEl) return;

    if (this.conflict) {
      syncEl.textContent = `冲突 · 本地 r${this.conflict.local} / 远端 r${this.conflict.remote}`;
      syncEl.className = "sync-conflict";
      syncEl.title = "远端已有新版本：在「文件与导出」里选择保留本地、采用远端或载入远端后再改";
      return;
    }

    const revision = this.el.revision;
    const dirty = this.el.dirty;
    syncEl.textContent = dirty ? `r${revision} · 未保存改动` : `已保存 r${revision}`;
    syncEl.className = dirty ? "sync-dirty" : "sync-ok";
    syncEl.title = dirty
      ? "文档已改动，尚未写回宿主：Ctrl+S 保存"
      : "文档与宿主保存的版本一致";
  }

  /**
   * Mark (or clear, with `null`) an unresolved conflict. The remote revision is
   * the server's; the local one is read live so a later edit cannot make the
   * label lie about which version is on screen.
   */
  setConflict(remote: number | null): void {
    this.conflict =
      remote === null
        ? null
        : { local: this.el.revision, remote };
    this.updateDocumentState();
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
    // Read the engine revision instead of hardcoding it in the markup: the
    // footer claims a version, so it has to be the one actually running.
    const revEl = document.querySelector("#three-rev");
    if (revEl) revEl.textContent = `three r${THREE.REVISION}`;

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
