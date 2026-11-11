/**
 * Demo: the document model as a host-facing contract.
 *
 * Migration is not an internal detail: hosts import JSON they did not write,
 * so `migrateSceneDocument` → `parseSceneDocument` → `validateHierarchy` is
 * the documented pre-flight for anything entering `loadDocument()`.
 */
import {
  SCHEMA_VERSION,
  SceneEditorError,
  migrateSceneDocument,
  parseSceneDocument,
  validateHierarchy,
  type SceneDocument,
} from "@scenio/scene-editor";
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";
import { createLog, q, setFields } from "./shared";

type Result = {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

interface DocumentDemoHook {
  last: () => Result | null;
  run: {
    migrate: () => Result;
    validate: () => Result;
    badHierarchy: () => Result;
    badColor: () => Result;
    badVersion: () => Result;
    importDoc: () => Promise<Result>;
  };
  state: () => { loaded: boolean; revision: number; sceneId: string };
}

declare global {
  interface Window {
    __docDemo: DocumentDemoHook;
  }
}

/** A v1 document: no `view` section at all — exactly what old integrations have. */
const v1Source = {
  schemaVersion: 1,
  sceneId: "imported-scene",
  revision: 0,
  objects: [
    {
      id: "import-box",
      type: "mesh",
      name: "Imported Box",
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "import-group",
      type: "group",
      name: "Imported Group",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

const log = createLog();
const sourceEl = q<HTMLTextAreaElement>("#source");
const outputEl = q<HTMLPreElement>("#output");
const statusEl = q("#status");

let editor: SceneEditorElement | null = null;
let last: Result | null = null;
let loaded = false;

sourceEl.value = JSON.stringify(v1Source, null, 2);
q("#schema-version").textContent = `SCHEMA_VERSION=${SCHEMA_VERSION}`;

function publish(result: Result, label: string): Result {
  last = result;
  outputEl.textContent = JSON.stringify(result, null, 2);
  if (result.ok) log.ok(label);
  else log.err(`${label}: ${result.code ?? "error"} — ${result.message ?? ""}`);
  return result;
}

function toResult(error: unknown): Result {
  if (error instanceof SceneEditorError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  // Untrusted textarea input: give parse failures a stable, switchable code
  // instead of leaking a raw SyntaxError message as the only signal.
  if (error instanceof SyntaxError) {
    return { ok: false, code: "invalid-json", message: error.message };
  }
  return { ok: false, code: "thrown", message: error instanceof Error ? error.message : String(error) };
}

function readSource(): unknown {
  return JSON.parse(sourceEl.value) as unknown;
}

/** Parse the textarea with migration + hierarchy validation (the documented path). */
function prepare(): SceneDocument {
  const { document } = migrateSceneDocument(readSource());
  const parsed = parseSceneDocument(document);
  validateHierarchy(parsed.objects);
  return parsed;
}

function migrate(): Result {
  try {
    const { document, applied } = migrateSceneDocument(readSource());
    const parsed = parseSceneDocument(document);
    validateHierarchy(parsed.objects);
    return publish(
      {
        ok: true,
        schemaVersion: parsed.schemaVersion,
        applied,
        view: parsed.view.camera,
        objectCount: parsed.objects.length,
      },
      `迁移通过 applied=${JSON.stringify(applied)}`,
    );
  } catch (error) {
    return publish(toResult(error), "迁移失败");
  }
}

function validate(): Result {
  try {
    const doc = prepare();
    return publish({ ok: true, hierarchy: "valid", objectCount: doc.objects.length }, "层级校验通过");
  } catch (error) {
    return publish(toResult(error), "层级校验失败");
  }
}

function badHierarchy(): Result {
  try {
    const doc = structuredClone(prepare());
    const child = doc.objects[0];
    if (!child) throw new Error("文档里至少要有一个对象");
    child.parentId = "ghost-parent"; // dangling reference, any object count
    validateHierarchy(doc.objects);
    return publish({ ok: true, note: "unexpected pass" }, "坏层级未报错");
  } catch (error) {
    return publish(toResult(error), "坏层级被拒绝");
  }
}

function badColor(): Result {
  try {
    const doc = structuredClone(prepare()) as SceneDocument;
    (doc.view.environment as { background: unknown }).background = "blue";
    parseSceneDocument(doc);
    return publish({ ok: true, note: "unexpected pass" }, "坏字段未报错");
  } catch (error) {
    return publish(toResult(error), "坏字段被拒绝");
  }
}

function badVersion(): Result {
  try {
    const raw = readSource() as Record<string, unknown>;
    migrateSceneDocument({ ...raw, schemaVersion: 99 });
    return publish({ ok: true, note: "unexpected pass" }, "未知版本未报错");
  } catch (error) {
    return publish(toResult(error), "未知版本被拒绝");
  }
}

async function importDoc(): Promise<Result> {
  if (!editor) return { ok: false, code: "lifecycle", message: "editor not ready" };
  try {
    await editor.loadDocument(readSource()); // migration runs inside loadDocument too
    loaded = true;
    const doc = editor.getDocument();
    render();
    return publish(
      {
        ok: true,
        sceneId: doc.sceneId,
        revision: doc.revision,
        schemaVersion: doc.schemaVersion,
        objectCount: doc.objects.length,
        view: doc.view.camera,
      },
      `导入成功 · ${doc.objects.length} objects · r${doc.revision}`,
    );
  } catch (error) {
    return publish(toResult(error), "导入失败");
  }
}

function render(): void {
  if (!editor || !loaded) return;
  const doc = editor.getDocument();
  setFields(statusEl, [
    ["sceneId", doc.sceneId],
    ["schemaVersion", doc.schemaVersion],
    ["revision", doc.revision],
    ["objects", doc.objects.length],
    ["view.fov", doc.view.camera.fov],
  ]);
}

async function main(): Promise<void> {
  defineSceneEditor();
  const el = q<SceneEditorElement>("#viewport");
  editor = el;
  el.addEventListener("error", (event) => {
    const detail = (event as unknown as CustomEvent<{ code: string; message: string }>).detail;
    log.err(`[${detail.code}] ${detail.message}`);
  });
  await el.ready;
  statusEl.textContent = "未加载文档 · 点“导入编辑器”把左侧 JSON 写进 viewport";

  q("#run-migrate").addEventListener("click", () => migrate());
  q("#run-validate").addEventListener("click", () => validate());
  q("#run-bad-hierarchy").addEventListener("click", () => badHierarchy());
  q("#run-bad-color").addEventListener("click", () => badColor());
  q("#run-bad-version").addEventListener("click", () => badVersion());
  q("#run-import").addEventListener("click", () => void importDoc());

  window.__docDemo = {
    last: () => last,
    run: { migrate, validate, badHierarchy, badColor, badVersion, importDoc },
    state: () => ({
      loaded,
      revision: editor?.revision ?? -1,
      sceneId: loaded ? editor!.getDocument().sceneId : "",
    }),
  };
  document.body.dataset.demo = "ready";
  log.ok("ready · 左侧是 v1 文档，先试“迁移 + 解析”再“导入编辑器”");
}

void main().catch((error: unknown) => {
  statusEl.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  log.err(`fatal: ${String(error)}`);
});
