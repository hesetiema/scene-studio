/**
 * Demo: the host-facing editing API.
 *
 * Covers the three SDK surfaces the studio UI does not exercise:
 *   - multi-select      `select` / `addToSelection` / `removeFromSelection` / `toggleSelection`
 *   - host commands     `executeCommand` (joins the gizmo undo stack)
 *   - inbound updates   `applyRemote` fast-forward + structured conflict resolution
 *
 * The save/conflict server is an in-memory object — the SDK never talks to a
 * backend (D17/D18), so every policy decision below is explicit host code.
 */
import {
  SceneEditorError,
  SceneErrorCode,
  type ConflictDocuments,
  type SceneDocument,
} from "@scenio/scene-editor";
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";
import { createLog, demoDoc, q, selectionText, setFields, transformOf } from "./shared";

interface HostApiDemoHook {
  state: () => {
    selected: string[];
    dirty: boolean;
    revision: number;
    serverRevision: number;
    canUndo: boolean;
    canRedo: boolean;
    labels: Record<string, string>;
    conflict: { base: number; incoming: number; local: number } | null;
  };
  actions: {
    selectAll: () => void;
    selectBox2: () => void;
    toggleBox2: () => void;
    tag: () => void;
    undo: () => void;
    redo: () => void;
    localEdit: () => void;
    pushRemote: () => Promise<string>;
    takeRemote: () => Promise<void>;
    keepLocal: () => void;
    reloadBase: () => Promise<void>;
    save: () => void;
  };
}

declare global {
  interface Window {
    __demo: HostApiDemoHook;
  }
}

const log = createLog();
const statusEl = q("#status");
const listEl = q("#objects");
const conflictEl = q<HTMLDivElement>("#conflict");
const conflictInfo = q<HTMLPreElement>("#conflict-info");
const undoBtn = q<HTMLButtonElement>("#undo");
const redoBtn = q<HTMLButtonElement>("#redo");

let editor: SceneEditorElement | null = null;
let canUndo = false;
let canRedo = false;
let tagSeq = 0;
/** Host-owned metadata: deliberately outside SceneDocument. */
const labels = new Map<string, string>();
/** In-memory "server": the document at the last acknowledged revision. */
let serverDoc: SceneDocument = structuredClone(demoDoc);
let conflict: ConflictDocuments | null = null;

function render(): void {
  if (!editor) return;
  setFields(statusEl, [
    ["selection", selectionText(editor.selectedIds)],
    ["dirty", editor.dirty],
    ["revision", editor.revision],
    ["server", serverDoc.revision],
    ["undo", canUndo],
    ["redo", canRedo],
  ]);

  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;

  const selected = new Set(editor.selectedIds);
  listEl.replaceChildren(
    ...editor.getDocument().objects.map((object) => {
      const row = document.createElement("div");
      row.className = "demo-item";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(selected.has(object.id)));
      row.dataset.objectId = object.id;

      const name = document.createElement("span");
      name.textContent = object.name;
      const id = document.createElement("span");
      id.className = "demo-item-id";
      id.textContent = object.id;
      row.append(name, id);

      const tag = labels.get(object.id);
      if (tag) {
        const badge = document.createElement("span");
        badge.className = "demo-item-tag";
        badge.textContent = tag;
        row.append(badge);
      }

      row.addEventListener("click", () => {
        editor?.toggleSelection(object.id);
      });
      return row;
    }),
  );

  if (conflict) {
    conflictEl.hidden = false;
    conflictInfo.textContent = [
      `conflict: SDK 不会自动合并`,
      `base     r${conflict.base.revision}`,
      `incoming r${conflict.incoming.revision}  (server)`,
      `local    r${conflict.local.revision}  (unsaved edits)`,
    ].join("\n");
  } else {
    conflictEl.hidden = true;
    conflictInfo.textContent = "";
  }
}

function makeRemote(): SceneDocument {
  const next = structuredClone(serverDoc);
  next.revision += 1;
  const object = next.objects.find((item) => item.id === "box-2");
  if (object) object.position = [object.position[0] + 0.7, object.position[1], object.position[2]];
  serverDoc = next; // the "server" now holds r+1
  return next;
}

async function pushRemote(): Promise<string> {
  if (!editor) return "not-ready";
  const remote = makeRemote();
  try {
    await editor.applyRemote(remote, { baseRevision: editor.revision });
    conflict = null;
    log.ok(`applyRemote fast-forward → r${remote.revision}`);
    render();
    return "fast-forward";
  } catch (error) {
    if (error instanceof SceneEditorError && error.code === SceneErrorCode.Conflict) {
      conflict = error.detail as unknown as ConflictDocuments;
      log.err(`applyRemote conflict (${error.message})`);
      render();
      return "conflict";
    }
    log.err(`applyRemote failed: ${String(error)}`);
    return "error";
  }
}

function localEdit(): void {
  if (!editor) return;
  const from = transformOf(editor.getDocument(), "box-1");
  editor.applyTransform("box-1", from, {
    ...from,
    position: [from.position[0] + 0.4, from.position[1], from.position[2]],
  });
  log(`applyTransform box-1 +0.4x (local edit, now dirty)`);
}

function tagSelected(): void {
  if (!editor) return;
  const ids = [...editor.selectedIds];
  if (ids.length === 0) {
    log.err("先选中对象再打标签");
    return;
  }
  tagSeq += 1;
  const nextTag = `tag-${tagSeq}`;
  const before = new Map(ids.map((id) => [id, labels.get(id)]));
  editor.executeCommand({
    label: "host:tag",
    execute: () => {
      for (const id of ids) labels.set(id, nextTag);
      render();
    },
    undo: () => {
      for (const [id, previous] of before) {
        if (previous === undefined) labels.delete(id);
        else labels.set(id, previous);
      }
      render();
    },
  });
  log.ok(`executeCommand host:tag → ${nextTag} on ${ids.length} object(s)`);
}

function save(): void {
  if (!editor) return;
  const local = editor.getDocument();
  if (local.revision !== serverDoc.revision) {
    log.err(`save rejected by host policy: local r${local.revision} ≠ server r${serverDoc.revision}`);
    return;
  }
  const next: SceneDocument = { ...local, revision: local.revision + 1 };
  serverDoc = structuredClone(next);
  editor.markSaved(next.revision);
  log.ok(`host accepted save → r${next.revision}`);
  render();
}

async function main(): Promise<void> {
  defineSceneEditor();
  const el = q<SceneEditorElement>("#viewport");
  editor = el;

  el.addEventListener("error", (event) => {
    const detail = (event as unknown as CustomEvent<{ code: string; message: string }>).detail;
    log.err(`[${detail.code}] ${detail.message}`);
  });
  el.addEventListener("selection-change", () => {
    log(`selection-change ${selectionText(el.selectedIds)}`);
    render();
  });
  el.addEventListener("history-change", (event) => {
    const detail = (
      event as CustomEvent<{ canUndo: boolean; canRedo: boolean; lastCommand?: string }>
    ).detail;
    canUndo = detail.canUndo;
    canRedo = detail.canRedo;
    log(`history-change ${detail.lastCommand ?? ""} (dirty=${el.dirty})`);
    render();
  });
  el.addEventListener("save-request", () => {
    log("save-request");
    save();
  });

  await el.ready;
  await el.loadDocument(structuredClone(demoDoc));
  await el.controlsReady;
  el.select(["box-1"]);
  render();
  log.ok("ready · 3 objects, 多选与远端更新可试");

  q("#sel-all").addEventListener("click", () =>
    el.select(el.getDocument().objects.map((object) => object.id)),
  );
  q("#sel-add").addEventListener("click", () => el.addToSelection(["box-2"]));
  q("#sel-remove").addEventListener("click", () => el.removeFromSelection(["box-1"]));
  q("#sel-clear").addEventListener("click", () => el.clearSelection());

  q("#cmd-tag").addEventListener("click", tagSelected);
  undoBtn.addEventListener("click", () => el.undo());
  redoBtn.addEventListener("click", () => el.redo());

  q("#remote-push").addEventListener("click", () => void pushRemote());
  q("#local-edit").addEventListener("click", localEdit);
  q("#save").addEventListener("click", () => el.requestSave());

  q("#resolve-remote").addEventListener("click", async () => {
    if (!conflict) return;
    const incoming = conflict.incoming;
    conflict = null;
    await el.loadDocument(incoming);
    log.ok(`采纳远端：loadDocument r${incoming.revision}（本地编辑丢弃）`);
    render();
  });
  q("#resolve-local").addEventListener("click", () => {
    if (!conflict) return;
    const incomingRevision = conflict.incoming.revision;
    conflict = null;
    // Host policy: pretend the server accepted our local doc at the server's
    // revision. The SDK itself never merges.
    el.markSaved(incomingRevision);
    el.requestSave();
    log(`保留本地：markSaved(${incomingRevision}) → requestSave()`);
    render();
  });
  q("#resolve-base").addEventListener("click", async () => {
    if (!conflict) return;
    const base = conflict.base;
    conflict = null;
    await el.loadDocument(base);
    log.ok(`重载基线 r${base.revision}（server 仍是 r${serverDoc.revision}）`);
    render();
  });

  document.body.dataset.demo = "ready";
  window.__demo = {
    state: () => ({
      selected: [...el.selectedIds],
      dirty: el.dirty,
      revision: el.revision,
      serverRevision: serverDoc.revision,
      canUndo,
      canRedo,
      labels: Object.fromEntries(labels),
      conflict: conflict
        ? {
            base: conflict.base.revision,
            incoming: conflict.incoming.revision,
            local: conflict.local.revision,
          }
        : null,
    }),
    actions: {
      selectAll: () => el.select(el.getDocument().objects.map((object) => object.id)),
      selectBox2: () => el.addToSelection(["box-2"]),
      toggleBox2: () => el.toggleSelection("box-2"),
      tag: tagSelected,
      undo: () => el.undo(),
      redo: () => el.redo(),
      localEdit,
      pushRemote,
      takeRemote: async () => {
        if (!conflict) return;
        const incoming = conflict.incoming;
        conflict = null;
        await el.loadDocument(incoming);
        render();
      },
      keepLocal: () => {
        if (!conflict) return;
        const incomingRevision = conflict.incoming.revision;
        conflict = null;
        el.markSaved(incomingRevision);
        el.requestSave();
        render();
      },
      reloadBase: async () => {
        if (!conflict) return;
        const base = conflict.base;
        conflict = null;
        await el.loadDocument(base);
        render();
      },
      save: () => el.requestSave(),
    },
  };
}

void main().catch((error: unknown) => {
  statusEl.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  log.err(`fatal: ${String(error)}`);
});
