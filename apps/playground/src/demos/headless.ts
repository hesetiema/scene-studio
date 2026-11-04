/**
 * Demo: the headless facade — no DOM, no canvas, no GPU.
 *
 * `createSceneEditor({ runtime: new FakeRuntime() })` is the same editor the
 * element wraps. Running the contract end-to-end here is the cheapest
 * regression surface in the repo: it needs neither WebGL nor a browser paint.
 */
import {
  FakeRuntime,
  SceneEditorError,
  SceneErrorCode,
  createSceneEditor,
  type SceneDocument,
  type SceneEditor,
} from "@scenio/scene-editor";
import { createLog, demoDoc, q, transformOf } from "./shared";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface CoverageHook {
  report: () => { passed: number; failed: number; checks: Check[] };
}

declare global {
  interface Window {
    __coverage: CoverageHook;
  }
}

const log = createLog();
const resultsEl = q<HTMLTableSectionElement>("#results");
const summaryEl = q("#summary");

const checks: Check[] = [];

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function renderRow(index: number, check: Check): void {
  const row = document.createElement("tr");
  const number = document.createElement("td");
  number.textContent = String(index + 1);
  const name = document.createElement("td");
  name.textContent = check.name;
  const result = document.createElement("td");
  result.textContent = check.ok ? "PASS" : "FAIL";
  result.className = check.ok ? "ok" : "fail";
  const detail = document.createElement("td");
  detail.textContent = check.detail;
  row.append(number, name, result, detail);
  resultsEl.append(row);
}

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    const check: Check = { name, ok: true, detail: "ok" };
    checks.push(check);
    renderRow(checks.length - 1, check);
    log.ok(name);
  } catch (error) {
    const check: Check = {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
    checks.push(check);
    renderRow(checks.length - 1, check);
    log.err(`${name}: ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const runtime = new FakeRuntime();
  const editor: SceneEditor = createSceneEditor({ runtime });
  const events: string[] = [];
  editor.on("selection-change", ({ ids }) => events.push(`selection:${ids.join("+")}`));
  editor.on("history-change", ({ lastCommand }) => events.push(`history:${lastCommand ?? "-"}`));
  editor.on("document-dirty", ({ dirty }) => events.push(`dirty:${dirty}`));
  editor.on("view-change", ({ source }) => events.push(`view:${source}`));
  const saves: Array<{ revision: number; objectCount: number }> = [];
  editor.on("save-request", ({ document, revision }) => {
    saves.push({ revision, objectCount: document.objects.length });
  });

  await run("loadDocument：zod 校验 + 写入 runtime", async () => {
    editor.select(["box-1"]);
    await editor.loadDocument(structuredClone(demoDoc));
    check(editor.getDocument().objects.length === 3, "object count ≠ 3");
    check(runtime.calls.loadDocument.length === 1, "runtime.loadDocument 未被调用");
    check(editor.selectedIds.length === 0, "load 后应清空选择");
    check(events.some((event) => event.startsWith("selection:")), "未广播 selection-change");
  });

  await run("选择：select / add / remove / toggle 组合", () => {
    editor.select(["box-1"]);
    editor.add(["box-2"]);
    editor.remove(["box-1"]);
    editor.toggle("box-3");
    check(
      JSON.stringify(editor.selectedIds) === JSON.stringify(["box-2", "box-3"]),
      `selectedIds=${JSON.stringify(editor.selectedIds)}`,
    );
  });

  await run("applyTransform：一条命令 + dirty", () => {
    const from = transformOf(editor.getDocument(), "box-1");
    editor.applyTransform("box-1", from, {
      ...from,
      position: [from.position[0] + 1, from.position[1], from.position[2]],
    });
    check(editor.dirty, "dirty 应为 true");
    check(editor.canUndo, "canUndo 应为 true");
  });

  await run("undo / redo：文档快照往返", () => {
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
    const moved = editor.getDocument().objects.find((object) => object.id === "box-1")!;
    check(near(moved.position[0], -0.6), `位置未生效: ${moved.position[0]}`);
    editor.undo();
    const restored = editor.getDocument().objects.find((object) => object.id === "box-1")!;
    check(near(restored.position[0], -1.6), `undo 未恢复: ${restored.position[0]}`);
    check(!editor.dirty, "undo 回干净点后 dirty 应为 false");
    editor.redo();
    check(near(editor.getDocument().objects[0]!.position[0], -0.6), "redo 未重放");
    editor.undo();
  });

  await run("executeCommand：宿主命令进入同一历史", () => {
    let value = 0;
    editor.executeCommand({
      label: "host:tick",
      execute: () => {
        value = 1;
      },
      undo: () => {
        value = 0;
      },
    });
    check(value === 1, "execute 未执行");
    check(editor.undo() && value === 0, "undo 未回滚宿主命令");
    check(editor.redo() && value === 1, "redo 未重放宿主命令");
    editor.undo();
  });

  await run("save：save-request 载荷 + markSaved 清脏", () => {
    editor.requestSave();
    check(saves.length === 1, "未收到 save-request");
    const payload = saves[0]!;
    check(payload.revision === 0, "revision 载荷错误");
    check(payload.objectCount === 3, "document 载荷错误");
    editor.markSaved(1);
    check(editor.revision === 1, "markSaved 未采用服务端 revision");
    check(!editor.dirty, "markSaved 后 dirty 应为 false");
  });

  await run("applyRemote：clean + base+1 快进", async () => {
    const current = editor.getDocument();
    const remote: SceneDocument = {
      ...current,
      revision: 2,
      objects: current.objects.map((object) =>
        object.id === "box-2"
          ? { ...object, position: [3, 0.5, 0] as [number, number, number] }
          : object,
      ),
    };
    await editor.applyRemote(remote, { baseRevision: 1 });
    check(editor.revision === 2, "未快进到 r2");
    check(runtime.calls.loadDocument.length === 2, "runtime 未收到远端文档");
  });

  await run("applyRemote：本地脏 → 结构化冲突", async () => {
    const from = transformOf(editor.getDocument(), "box-1");
    editor.applyTransform("box-1", from, {
      ...from,
      position: [from.position[0] + 0.5, from.position[1], from.position[2]],
    });
    const incoming: SceneDocument = { ...editor.getDocument(), revision: 3 };
    let conflict: SceneEditorError | null = null;
    try {
      await editor.applyRemote(incoming, { baseRevision: 2 });
    } catch (error) {
      if (!(error instanceof SceneEditorError)) throw error;
      conflict = error;
    }
    check(conflict !== null, "脏状态下的远端更新未冲突");
    check(conflict!.code === SceneErrorCode.Conflict, `code=${conflict!.code}`);
    check(conflict!.detail?.incoming !== undefined, "缺少 base/incoming/local");
    check(editor.revision === 2, "冲突后本地 revision 不应变化");
  });

  await run("handleKeyDown：Ctrl+Z 消费，普通键放行", () => {
    check(
      editor.handleKeyDown({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false }),
      "Ctrl+Z 未被消费",
    );
    check(
      editor.handleKeyDown({ key: "g", ctrlKey: false, metaKey: false, shiftKey: false }),
      "保留键 G 未被消费",
    );
    check(
      !editor.handleKeyDown({ key: "a", ctrlKey: false, metaKey: false, shiftKey: false }),
      "普通键不应被消费",
    );
  });

  await run("插件：install / 事件 / disposer", () => {
    let installed = false;
    let disposed = false;
    let sawSelection = false;
    editor.use({
      id: "coverage-plugin",
      install: ({ on, addDisposer }) => {
        installed = true;
        const off = on("selection-change", () => {
          sawSelection = true;
        });
        addDisposer(off);
        addDisposer(() => {
          disposed = true;
        });
      },
    });
    check(installed, "install 未执行");
    editor.select(["box-3"]);
    check(sawSelection, "插件未收到 selection-change");
    editor.unuse("coverage-plugin");
    check(disposed, "disposer 未执行");
  });

  await run("destroy：幂等销毁 + lifecycle 错误", () => {
    editor.destroy();
    let code = "";
    try {
      editor.getDocument();
    } catch (error) {
      code = error instanceof SceneEditorError ? error.code : "not-scene-error";
    }
    check(code === SceneErrorCode.Lifecycle, `destroy 后未抛 lifecycle，实际 ${code}`);
  });

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  summaryEl.textContent = `${passed}/${checks.length} passed`;
  document.body.dataset.coverage = failed === 0 ? "pass" : "fail";
  window.__coverage = {
    report: () => ({ passed, failed, checks: [...checks] }),
  };
}

void main().catch((error: unknown) => {
  document.body.dataset.coverage = "fail";
  summaryEl.textContent = "runner crashed";
  log.err(`fatal: ${String(error)}`);
});
