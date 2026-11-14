import {
  SCENE_EDITOR_VERSION,
  SceneEditorError,
  SceneErrorCode,
  type ConflictDocuments,
  type SceneDocument,
  type SceneObjectDTO,
} from "@scenio/scene-editor";
import { SceneEditorElement, defineSceneEditor } from "@scenio/scene-editor/element";
import { ThreeRuntime, createSelectionHighlightPlugin } from "@scenio/scene-editor/three";
import { ModelLoader } from "./assets/model-loader";
import { WelcomeScreen } from "./ui/welcome-screen";
import { CameraController } from "./camera/camera-controller";
import { HUDController } from "./ui/hud-controller";
import { StudioShell } from "./ui/studio-shell";
import { ConflictController } from "./ui/conflict-controller";
import type { ModeSwitch, StudioMode } from "./ui/mode-switch";
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
    __mode?: ModeSwitch;
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
SceneEditorElement.runtimeFactory = (canvas, options) => {
  // A custom factory has to honour `interactive` too, or the element's viewer
  // mode would still mount a transform gizmo.
  const runtime = new ThreeRuntime({
    canvas,
    assetCache,
    ...(options?.interactive === undefined ? {} : { interactive: options.interactive }),
  });
  runtimeInstance = runtime;
  window.__runtime = runtime;
  return runtime;
};

// Boot mode is fixed *before* the element upgrades: `#init()` reads `mode` to
// decide whether the runtime is created with `interactive: false`, so setting it
// later would briefly mount (and then tear down) a transform gizmo. Loaded
// models are viewers by default; `?mode=editor` is the explicit editor entry
// used by the e2e fixtures, and the top-bar switch can flip it at any time.
const bootParams = new URLSearchParams(location.search);
const initialMode: StudioMode = bootParams.get("mode") === "editor" ? "editor" : "viewer";
document.querySelector("scene-editor")?.setAttribute("mode", initialMode);
document.body.dataset.studioMode = initialMode;

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
const viewer = new ViewerController({ store, el, getRuntime });
viewer.mount();

/** 撤销/重做覆盖面板设置（valtio 快照）、文档命令（SDK 历史）与相机位姿（宿主栈）。 */
const history = new HistoryCoordinator(el, store);

// 载入后的自动取景只挪相机、不写文档（`commit: false`），因此不会发 view-change。
// 但它确实改变了用户看到的画面，所以要把视角栈的基线挪过去，否则第一笔撤销会
// 跳回文档声明的旧机位。
camera.onProgrammaticView = () => history.resetCameraBaseline();

/** In-memory host store for e2e save/conflict flows (D18/D17). */
const host = {
  serverDoc: structuredClone(emptyDoc),
  forceConflict: false,
  saves: 0,
};

/** 最近一次载入的名称/格式：采用远端版本时沿用，不要退回占位文案。 */
const lastTelemetry = { name: "未载入模型", format: "—" };

/**
 * 冲突的宿主那一半：SDK 只抛出两边文档，谁来选由宿主决定。
 * 「保留本地」把本地写回服务端，「采用远端」直接换成对方的文档。
 */
const conflicts = new ConflictController({
  hud,
  adoptRemote: (remote) => applyDocument(remote, lastTelemetry.name, lastTelemetry.format, false),
  overwriteRemote: (local, remote) => {
    // 服务端已经在 rN，本地再写上去就是 rN+1：修订号只能往前，不能回退。
    const next: SceneDocument = {
      ...structuredClone(local),
      revision: Math.max(local.revision, remote.revision) + 1,
    };
    host.saves += 1;
    host.serverDoc = structuredClone(next);
    window.__savedDocs.push(structuredClone(next));
    el.markSaved(next.revision);
    hud.updateDocumentState();
    return next.revision;
  },
});

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
  simulateRemote: simulateRemoteChange,
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
  // 新文档 = 旧的冲突已经被这次载入消化掉了。
  conflicts.clear();

  await el.loadDocument(doc);

  lastTelemetry.name = telemetryName;
  lastTelemetry.format = telemetryFormat;

  shell.onDocumentLoaded();
  shell.selectModelOption(option ?? null);
  hud.updateTelemetry(telemetryName, telemetryFormat);

  if (frame) camera.frameScene(false);

  // 载入 + 自动取景 = 新的基线：视角栈在这里归零，否则刚打开模型按 Ctrl+Z
  // 会退回载入前的机位（那是上一份文档的位姿，对新模型没有意义）。
  history.resetCameraBaseline();

  // 打开文档时的自动取景属于「载入」而不是用户编辑：把它作为新的干净基线，
  // 否则状态栏会在刚载入时就显示「已修改」。
  host.serverDoc = structuredClone(el.getDocument());
  el.markSaved(el.revision);
  hud.updateDocumentState();

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
  // 回到首页 = 下一次载入重新从查看态开始。
  shell.modeSwitch.set("viewer", false);
  camera.frameScene(false, false);
  hud.showToast("已回到首页");
}

document.querySelector("#btn-home")?.addEventListener("click", () => {
  void goHome();
});

window.loadCustomModel = loadCustomModel;
window.loadCustomFiles = loadFilesModel;

// ---------------------------------------------------------------------------
// Remote sync rehearsal (`applyRemote`)
// ---------------------------------------------------------------------------

/**
 * 把服务端当成「另一个客户端刚提交过」：本地干净就快进，有未保存改动就报冲突。
 * 这是 D17 的完整闭环 —— SDK 只抛结构化冲突，选择权在宿主（决策条）。
 */
async function simulateRemoteChange(): Promise<void> {
  const base = host.serverDoc;
  const remote = remoteWithNewPart(base);

  try {
    await el.applyRemote(remote, { baseRevision: base.revision });
    // 元素自己换了文档（历史已清空、revision 已是远端值），所以不走 applyDocument。
    host.serverDoc = structuredClone(remote);
    shell.onDocumentLoaded();
    history.resetCameraBaseline();
    hud.updateDocumentState();
    hud.showToast(`已快进到远端修订 ${remote.revision}`);
  } catch (error) {
    const docs = conflictOf(error);
    if (docs) {
      pushConflict(docs);
      return;
    }
    hud.showToast(error instanceof Error ? `远端同步失败：${error.message}` : "远端同步失败");
  }
}

/** 远端版本 = 当前服务端文档 + 一个可见的新部件 + 修订号 +1。 */
function remoteWithNewPart(base: SceneDocument): SceneDocument {
  const objects = base.objects.map((object) => structuredClone(object));
  const revision = base.revision + 1;

  let id = `remote-${revision}`;
  for (let suffix = 2; objects.some((object) => object.id === id); suffix += 1) {
    id = `remote-${revision}-${suffix}`;
  }

  const part: SceneObjectDTO = {
    id,
    type: "primitive",
    name: "远端新增部件",
    geometry: { kind: "box" },
    position: [1.5, 0.4, 1],
    rotation: [0, 0, 0],
    scale: [0.8, 0.8, 0.8],
  };

  return {
    ...structuredClone(base),
    revision,
    objects: [...objects, part],
  };
}

/** `applyRemote` 抛的是 `SceneEditorError`，`detail` 里带着两边文档。 */
function conflictOf(error: unknown): ConflictDocuments | null {
  if (!(error instanceof SceneEditorError) || error.code !== SceneErrorCode.Conflict) return null;
  const detail = error.detail as Partial<ConflictDocuments> | undefined;
  if (!detail?.base || !detail.incoming || !detail.local) return null;
  return detail as ConflictDocuments;
}

// ---------------------------------------------------------------------------
// Host persistence + conflict surface (D17/D18)
// ---------------------------------------------------------------------------

el.addEventListener("save-request", () => {
  const local = el.getDocument();

  // 查看态是只读的（保存按钮已隐藏，但 Ctrl+S 仍会派发这个事件）；
  // 空场景同样没有可保存的内容。
  if (shell.modeSwitch.mode === "viewer" || local.objects.length === 0) return;

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
  conflicts.clear();
  hud.updateDocumentState();
  hud.showToast(`已保存 修订 ${next.revision}`);
});

function pushConflict(conflict: ConflictDocuments): void {
  window.__conflicts.push(conflict);
  el.dispatchEvent(new CustomEvent("save-conflict", { detail: conflict }));
  // 决策条是宿主自己画的：SDK 只负责把两边文档交回来（D17）。
  conflicts.show(conflict);
}

el.addEventListener("history-change", () => hud.updateDocumentState());
el.addEventListener("selection-change", () => hud.updateSelectionUI());
el.addEventListener("error", (event) => {
  const detail = (event as unknown as CustomEvent<{ code?: string; message?: string }>).detail;
  // 冲突有专门的可操作出口（决策条），不再用一句英文 toast 重复一遍。
  if (detail?.code === SceneErrorCode.Conflict) return;
  hud.showToast(detail?.message ?? "SDK 异常");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Plugin demo: selection highlight (design §5, install(context)).
el.use(createSelectionHighlightPlugin());
shell.mount();
conflicts.mount();
welcome.mount();
document.body.dataset.boot = "pending";

void el.ready.then(async () => {
  const params = bootParams;
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
  // 写死在文档里的相机距离无法保证模型完整可见。
  //
  // 这一步**要写回文档**（commit），而不是只挪运行时相机。只挪相机的话文档里的
  // 机位和屏幕上的一直不一致，用户撤销一次视角就会把「自动取景的机位」写进文档，
  // 而保存下来的仍是另一个机位 —— 于是撤销到底也回不到干净态（实测：文档 4.6/2.8/5.4，
  // 屏幕 4.31/3.42/5.15）。写回 + 立刻 markSaved 之后两边一致，撤销回基线就是干净态。
  camera.frameScene(false);
  el.markSaved(el.revision);
  host.serverDoc = structuredClone(el.getDocument());

  if (selectId) {
    el.selectObject(selectId);
    applyTransformFromQuery(selectId, params);
  }

  await el.controlsReady;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  document.body.dataset.boot = "ready";
  hud.updateDocumentState();
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
window.__mode = shell.modeSwitch;

// 宿主接管 Ctrl+Z / Ctrl+Y：焦点在视口内时也不会和元素内置的撤销重复执行。
// 查看态同样接管——视角与观看设置的撤销不改文档；「文档命令只在编辑态可撤」
// 这条门禁在 HistoryCoordinator 内部判断，所以这里不再传模式开关。
bindHistoryHotkeys(history, window);
