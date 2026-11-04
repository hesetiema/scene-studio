import { SCENE_EDITOR_VERSION, type SceneDocument } from "@scenio/scene-editor";
import { SceneEditorElement, defineSceneEditor } from "@scenio/scene-editor/element";
import { ThreeRuntime, createSelectionHighlightPlugin } from "@scenio/scene-editor/three";
import { ModelLoader } from "./assets/model-loader";
import { WelcomeScreen } from "./ui/welcome-screen";
import { CameraController } from "./camera/camera-controller";
import { HUDController } from "./ui/hud-controller";
import { StudioShell } from "./ui/studio-shell";
import { bindHistoryHotkeys, HistoryCoordinator } from "./viewer/history-coordinator";
import { createViewerStore, type ViewerStore } from "./viewer/viewer-state";
import { ViewerController } from "./viewer/viewer-controller";
import { defaultMultiDoc, emptyDoc } from "./bootstrap";

declare global {
  interface Window {
    __editor: SceneEditorElement;
    __host: typeof host;
    __savedDocs: SceneDocument[];
    __conflicts: unknown[];
    __runtime?: ThreeRuntime;
    __viewer?: ViewerController;
    __store?: ViewerStore;
    __history?: HistoryCoordinator;
    loadCustomModel: (urlOrFile: string | File, name?: string) => Promise<void>;
    loadCustomFiles: (files: File[]) => Promise<void>;
  }
}

// ---------------------------------------------------------------------------
// Composition root: runtime factory → element → viewer state → panels → host.
// UI wiring lives in StudioShell; the viewer store keeps panels declarative.
// ---------------------------------------------------------------------------

const modelLoader = new ModelLoader();
const assetCache = modelLoader.getAssetCache();

let runtimeInstance: ThreeRuntime | null = null;

// Must be registered BEFORE defineSceneEditor() upgrades the element.
SceneEditorElement.runtimeFactory = (canvas) => {
  const runtime = new ThreeRuntime({ canvas, assetCache });
  runtimeInstance = runtime;
  window.__runtime = runtime;
  return runtime;
};

defineSceneEditor();

// Keep the visible badge tied to the package version instead of a hardcoded HTML string.
const versionBadge = document.querySelector("#version-badge");
if (versionBadge) versionBadge.textContent = `v${SCENE_EDITOR_VERSION}`;

const el = document.querySelector("scene-editor") as SceneEditorElement;
const getRuntime = (): ThreeRuntime | null =>
  runtimeInstance ?? ((el.runtime as ThreeRuntime | undefined) ?? null);

const camera = new CameraController(el, getRuntime);
const hud = new HUDController(el, getRuntime);

const store = createViewerStore();
const viewer = new ViewerController({ store, el, getRuntime, camera });
viewer.mount();

/** 撤销/重做覆盖面板设置（valtio 快照）与文档命令（SDK 历史）。 */
const history = new HistoryCoordinator(el, store);

/** In-memory host store for e2e save/conflict flows (D18/D17). */
const host = {
  serverDoc: structuredClone(emptyDoc),
  forceConflict: false,
  saves: 0,
};

window.__editor = el;
window.__host = host;
window.__savedDocs = [];
window.__conflicts = [];

const shell = new StudioShell({
  el,
  getRuntime,
  hud,
  camera,
  store,
  viewer,
  history,
  loadPreset: loadModelByOption,
  loadCustom: loadCustomModel,
  loadFiles: loadFilesModel,
});

/** 空状态引导：未载入模型时覆盖视口，上传 / 选示例后自动隐藏。 */
const welcome = new WelcomeScreen({
  onPickPreset: (value) => void loadModelByOption(value),
  onUpload: () => document.querySelector<HTMLInputElement>("#file-input")?.click(),
});

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------

async function applyDocument(
  doc: SceneDocument,
  telemetryName: string,
  telemetryFormat: string,
  frame: boolean,
  option?: string,
): Promise<void> {
  await el.loadDocument(doc);

  shell.onDocumentLoaded();
  shell.selectModelOption(option ?? null);
  hud.updateTelemetry(telemetryName, telemetryFormat);

  if (frame) camera.frameScene(false);

  // 打开文档时的自动取景属于「载入」而不是用户编辑：把它作为新的干净基线，
  // 否则状态栏会在刚载入时就显示「已修改」。
  host.serverDoc = structuredClone(el.getDocument());
  el.markSaved(el.revision);
  hud.updateDirtyUI();

  // 空文档 = 首次进入：显示上传引导；载入任何内容后收起。
  if (doc.objects.length === 0) welcome.show();
  else welcome.hide();
}

async function loadModelByOption(value: string): Promise<void> {
  const preset = modelLoader.createModelDocByOption(value);
  if (!preset) return;
  await applyDocument(preset.doc, preset.telemetryName, preset.telemetryFormat, true, value);
}

async function loadCustomModel(urlOrFile: string | File, customName?: string): Promise<void> {
  try {
    const { doc, filename, format } = await modelLoader.createCustomModelDoc(urlOrFile, customName);
    await applyDocument(doc, filename, format, true);
    hud.showToast(`已载入 ${filename}`);
  } catch (error) {
    hud.showToast(error instanceof Error ? `加载失败：${error.message}` : "3D 模型加载失败");
  }
}

/** Drop / pick a multi-file bundle: .gltf + .bin + textures resolve in-place. */
async function loadFilesModel(files: File[]): Promise<void> {
  try {
    const { doc, filename, format } = await modelLoader.createFilesModelDoc(files);
    await applyDocument(doc, filename, format, true);
    hud.showToast(`已载入 ${filename}`);
  } catch (error) {
    hud.showToast(error instanceof Error ? `加载失败：${error.message}` : "3D 模型加载失败");
  }
}

/** 回到首页：清空文档，空场景会自动恢复上传 / 示例引导。 */
async function goHome(): Promise<void> {
  try {
    if (el.getDocument().objects.length === 0) return;
  } catch {
    return;
  }
  await applyDocument(emptyDoc, "未载入模型", "—", false);
  camera.frameScene(false, false);
  hud.showToast("已回到首页");
}

document.querySelector("#btn-home")?.addEventListener("click", () => {
  void goHome();
});

window.loadCustomModel = loadCustomModel;
window.loadCustomFiles = loadFilesModel;

// ---------------------------------------------------------------------------
// Host persistence + conflict surface (D17/D18)
// ---------------------------------------------------------------------------

el.addEventListener("save-request", () => {
  const local = el.getDocument();

  // 首页没有可保存的内容（保存按钮与快捷键在空场景下都不该落库）。
  if (local.objects.length === 0) return;

  if (host.forceConflict) {
    const incoming: SceneDocument = { ...host.serverDoc, revision: host.serverDoc.revision + 1 };
    pushConflict({ base: { ...host.serverDoc }, incoming, local });
    host.forceConflict = false;
    return;
  }

  if (local.revision !== host.serverDoc.revision) {
    pushConflict({
      base: { ...host.serverDoc, revision: local.revision },
      incoming: host.serverDoc,
      local,
    });
    return;
  }

  host.saves += 1;
  const next: SceneDocument = { ...local, revision: local.revision + 1 };
  host.serverDoc = structuredClone(next);
  window.__savedDocs.push(structuredClone(next));
  el.markSaved(next.revision);
  hud.updateDirtyUI();
  hud.showToast(`已保存 修订 ${next.revision}`);
});

function pushConflict(conflict: { base: SceneDocument; incoming: SceneDocument; local: SceneDocument }): void {
  window.__conflicts.push(conflict);
  el.dispatchEvent(new CustomEvent("save-conflict", { detail: conflict }));
}

el.addEventListener("save-conflict", () => {
  document.body.dataset.conflict = "true";
  hud.showToast("检测到保存冲突，请先合并远端版本");
});

el.addEventListener("history-change", () => hud.updateDirtyUI());
el.addEventListener("selection-change", () => hud.updateSelectionUI());
el.addEventListener("error", (event) => {
  const detail = (event as unknown as CustomEvent<{ message?: string }>).detail;
  hud.showToast(detail?.message ?? "SDK 异常");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Plugin demo: selection highlight (design §5, install(context)).
el.use(createSelectionHighlightPlugin());
shell.mount();
welcome.mount();
document.body.dataset.boot = "pending";

void el.ready.then(async () => {
  const params = new URLSearchParams(location.search);
  const selectId = params.get("select");
  const requestedModel = params.get("model");
  // `?scene=default` (or any `?select=`) loads the deterministic fixture the
  // e2e suites assert on; `?model=<preset>` jumps straight to one sample; the
  // bare URL boots an empty scene and waits for a file or a sample pick, so a
  // first visit never downloads a model the user did not ask for.
  const useFixture = params.get("scene") === "default" || selectId !== null;

  if (useFixture) {
    await applyDocument(defaultMultiDoc, "几何体组合场景", "默认场景", false);
  } else if (requestedModel && modelLoader.createModelDocByOption(requestedModel)) {
    await loadModelByOption(requestedModel);
  } else {
    await applyDocument(emptyDoc, "未载入模型", "—", false);
  }

  // 首次加载后一次性适配视口：预设资产的尺度从毫米到数百米不等，
  // 写死在文档里的相机距离无法保证模型完整可见（只移动相机，不改文档）。
  camera.frameScene(false, false);

  if (selectId) {
    el.selectObject(selectId);
    applyTransformFromQuery(selectId, params);
  }

  await el.controlsReady;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  document.body.dataset.boot = "ready";
  hud.updateDirtyUI();
});

/** e2e hooks: `?select=box-1&move=1,0.5,0&rot=0,0,0&scale=1,1,1`. */
function applyTransformFromQuery(id: string, params: URLSearchParams): void {
  const move = params.get("move");
  const rot = params.get("rot");
  const scale = params.get("scale");
  if (!move && !rot && !scale) return;

  const from = el.getDocument().objects.find((object) => object.id === id);
  if (!from) return;

  const parseVec = (value: string | null, fallback: readonly [number, number, number]) =>
    value ? (value.split(",").map(Number) as [number, number, number]) : fallback;

  el.applyTransform(
    id,
    { position: from.position, rotation: from.rotation, scale: from.scale },
    {
      position: parseVec(move, from.position),
      rotation: parseVec(rot, from.rotation),
      scale: parseVec(scale, from.scale),
    },
  );
}

window.__viewer = viewer;
window.__store = store;
window.__history = history;

// 宿主接管 Ctrl+Z / Ctrl+Y：焦点在视口内时也不会和元素内置的撤销重复执行。
bindHistoryHotkeys(history);
