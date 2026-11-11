/**
 * `minimal.html` entry point — the smallest end-to-end host integration:
 * element + `loadDocument` + save loop. The code runs synchronously so
 * `scene-editor` upgrades at once: some decoder/e2e probes wait on
 * `customElements.get()` and must not race a dynamic import.
 *
 * The SDK coverage scenarios that used to share this entry (`?demo=<name>`)
 * have been removed. Studio-side regression now lives in `e2e/*.spec.ts`
 * against the bare pages (`/`, `/minimal.html`, `/perf.html`).
 */
import { SCHEMA_VERSION, type SceneDocument, type Transform } from "@scenio/scene-editor";
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime, TransformMode } from "@scenio/scene-editor/three";

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const logEl = document.querySelector<HTMLDivElement>("#log")!;

function log(line: string): void {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${logEl.textContent ?? ""}`;
  logEl.scrollTop = 0;
}

/** 一份最小的合法文档：mesh 没有 assetId 时会渲染占位立方体（1×1×1）。 */
const demoDocument: SceneDocument = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "minimal-demo",
  revision: 1,
  objects: [
    {
      id: "box-1",
      type: "mesh",
      name: "Box A",
      position: [-1.2, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "box-2",
      type: "mesh",
      name: "Box B",
      position: [1.2, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
  view: {
    camera: { position: [6, 5, 10], target: [0, 0.5, 0], fov: 50 },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.55 },
      directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
    },
    environment: { background: "#0b0f19", gridVisible: true },
  },
};

function transformOf(doc: SceneDocument, id: string): Transform {
  const object = doc.objects.find((item) => item.id === id);
  if (!object) throw new Error(`object not found: ${id}`);
  return { position: object.position, rotation: object.rotation, scale: object.scale };
}

async function main(): Promise<void> {
  defineSceneEditor(); // idempotent + SSR 安全

  const el = document.querySelector<SceneEditorElement>("#viewport")!;
  const undoBtn = document.querySelector<HTMLButtonElement>("#undo")!;
  const redoBtn = document.querySelector<HTMLButtonElement>("#redo")!;
  const saveBtn = document.querySelector<HTMLButtonElement>("#save")!;

  let canUndo = false;
  let canRedo = false;

  const renderStatus = (): void => {
    const selected = el.selectedIds.join(", ") || "-";
    statusEl.textContent = `dirty=${el.dirty}  revision=${el.revision}  selected=${selected}  undo=${canUndo}  redo=${canRedo}`;
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
    saveBtn.disabled = !el.dirty;
  };

  // 失败统一从 error 事件拿到稳定 code，不要解析 message。
  el.addEventListener("error", (event) => {
    const { code, message } = (event as unknown as CustomEvent<{ code: string; message: string }>)
      .detail;
    log(`[error] ${code}: ${message}`);
  });

  el.addEventListener("selection-change", (event) => {
    log(`selection-change ${JSON.stringify((event as CustomEvent).detail)}`);
    renderStatus();
  });
  el.addEventListener("history-change", (event) => {
    const detail = (
      event as CustomEvent<{ canUndo: boolean; canRedo: boolean; lastCommand?: string }>
    ).detail;
    canUndo = detail.canUndo;
    canRedo = detail.canRedo;
    log(`history-change ${detail.lastCommand ?? ""}`);
    renderStatus();
  });
  el.addEventListener("document-dirty", (event) => {
    log(`document-dirty ${JSON.stringify((event as CustomEvent).detail)}`);
    renderStatus();
  });

  // host 侧保存：SDK 不碰后端，只发 save-request；成功后才 markSaved。
  el.addEventListener("save-request", (event) => {
    const { document, revision } = (event as CustomEvent<{ document: SceneDocument; revision: number }>)
      .detail;
    log(`save-request revision=${revision} objects=${document.objects.length}`);

    // 真实项目：await fetch("/api/scene", { method: "PUT", body: JSON.stringify(document) })
    const nextRevision = revision + 1; // 服务端返回的新 revision
    window.setTimeout(() => {
      el.markSaved(nextRevision);
      log(`markSaved ${nextRevision} (dirty 已清零)`);
      renderStatus();
    }, 200);
  });

  await el.ready;
  await el.loadDocument(structuredClone(demoDocument));
  await el.controlsReady; // gizmo 挂载完成（非 three runtime 立即 resolve）
  el.selectObject("box-1");
  renderStatus();
  log(`ready · ${demoDocument.objects.length} objects loaded`);

  // gizmo 工具切换：ThreeRuntime 的额外能力，核心契约之外。
  const runtime = el.runtime as ThreeRuntime;
  const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
  const setMode = (mode: TransformMode): void => {
    runtime.setTransformMode(mode);
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    log(`transformMode → ${mode}`);
  };
  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.mode as TransformMode));
  }

  // host 自带的可撤销动作：和 gizmo 拖拽共用同一条历史。
  document.querySelector<HTMLButtonElement>("#nudge")!.addEventListener("click", () => {
    const from = transformOf(el.getDocument(), "box-1");
    const to: Transform = {
      ...from,
      position: [from.position[0] + 0.5, from.position[1], from.position[2]],
    };
    el.applyTransform("box-1", from, to);
    log("applyTransform box-1 +0.5x");
  });

  undoBtn.addEventListener("click", () => el.undo());
  redoBtn.addEventListener("click", () => el.redo());
  saveBtn.addEventListener("click", () => el.requestSave());
}

void main().catch((error: unknown) => {
  statusEl.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  log(`[fatal] ${String(error)}`);
});
