import { describe, expect, it, vi } from "vitest";
import { createSceneEditor } from "../../src/runtime/create-scene-editor";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { SceneDocument } from "../../src/core/document/schema";
import type { SceneEditorPlugin } from "../../src/plugins/plugin";
import { SceneEditorError } from "../../src/core/events/errors";

const doc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "headless",
  revision: 0,
  objects: [
    {
      id: "a",
      type: "mesh",
      name: "A",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "b",
      type: "mesh",
      name: "B",
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

function setup() {
  const fake = new FakeRuntime();
  const editor = createSceneEditor({ runtime: fake });
  return { fake, editor };
}

const T = {
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0] as const,
  scale: [1, 1, 1] as const,
};

describe("createSceneEditor — document & history", () => {
  it("loads a document and exposes snapshot getters", async () => {
    const { editor, fake } = setup();
    await editor.loadDocument(doc);
    expect(editor.getDocument().sceneId).toBe("headless");
    expect(editor.revision).toBe(0);
    expect(editor.dirty).toBe(false);
    expect(fake.calls.loadDocument).toHaveLength(1);
  });

  it("rejects invalid documents with a typed error and emits error event", async () => {
    const { editor } = setup();
    const errors: Array<{ code: string }> = [];
    editor.on("error", (e) => errors.push(e));
    await expect(editor.loadDocument({ schemaVersion: 1 })).rejects.toBeInstanceOf(
      SceneEditorError,
    );
    expect(errors[0]?.code).toBe("validation");
  });

  it("applyTransform → dirty, undo/redo round-trips", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const to = { ...T, position: [5, 0, 0] as const };
    editor.applyTransform("a", T, to);
    expect(editor.dirty).toBe(true);
    expect(editor.canUndo).toBe(true);
    const posOfA = (): unknown =>
      editor.getDocument().objects.find((o) => o.id === "a")?.position;
    expect(posOfA()).toEqual([5, 0, 0]);
    expect(editor.undo()).toBe(true);
    expect(posOfA()).toEqual([0, 0, 0]);
    expect(editor.redo()).toBe(true);
    expect(posOfA()).toEqual([5, 0, 0]);
  });

  it("markSaved adopts revision and clears dirty", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    editor.applyTransform("a", T, { ...T, position: [1, 1, 1] });
    editor.markSaved(7);
    expect(editor.revision).toBe(7);
    expect(editor.dirty).toBe(false);
  });

  it("executeCommand registers a host-defined undoable action", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    let counter = 0;
    editor.executeCommand({
      label: "host:increment",
      execute: () => {
        counter = 1;
      },
      undo: () => {
        counter = 0;
      },
    });
    expect(counter).toBe(1);
    expect(editor.undo()).toBe(true);
    expect(counter).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  it("applyRemote fast-forwards clean docs and throws conflict on divergence (D17)", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const next: SceneDocument = { ...structuredClone(doc), revision: 1 };
    await editor.applyRemote(next, { baseRevision: 0 });
    expect(editor.revision).toBe(1);

    editor.applyTransform("a", T, { ...T, position: [9, 0, 0] });
    const conflicting: SceneDocument = { ...structuredClone(doc), revision: 2 };
    expect(() => editor.applyRemote(conflicting, { baseRevision: 1 })).toThrow(
      /revision conflict/i,
    );
  });
});

describe("createSceneEditor — selection", () => {
  it("select is set semantics; add/remove/toggle compose", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    editor.select(["a"]);
    expect([...editor.selectedIds]).toEqual(["a"]);
    editor.add(["b", "a"]);
    expect([...editor.selectedIds].sort()).toEqual(["a", "b"]);
    editor.remove(["a"]);
    expect([...editor.selectedIds]).toEqual(["b"]);
    editor.toggle("a");
    expect([...editor.selectedIds].sort()).toEqual(["a", "b"]);
    editor.toggle("b");
    expect([...editor.selectedIds]).toEqual(["a"]);
    editor.clearSelection();
    expect(editor.selectedIds).toHaveLength(0);
  });

  it("emits selection-change with final ids", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const seen: string[][] = [];
    editor.on("selection-change", (e) => seen.push(e.ids));
    editor.select(["a"]);
    editor.add(["b"]);
    editor.clearSelection();
    expect(seen).toEqual([["a"], ["a", "b"], []]);
  });

  it("no-op selection does not re-emit", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const spy = vi.fn();
    editor.on("selection-change", spy);
    editor.select(["a"]);
    editor.select(["a"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("createSceneEditor — events", () => {
  it("history-change and document-dirty track the dirty boundary", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const dirtyEdges: boolean[] = [];
    let historyEvents = 0;
    editor.on("history-change", () => {
      historyEvents += 1;
    });
    editor.on("document-dirty", (e) => dirtyEdges.push(e.dirty));

    editor.applyTransform("a", T, { ...T, position: [2, 0, 0] });
    editor.markSaved(1);
    expect(historyEvents).toBeGreaterThan(0);
    expect(dirtyEdges).toEqual([true, false]);
  });

  it("save-request carries document + revision", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const saves: Array<{ reason: string; revision: number }> = [];
    editor.on("save-request", (e) =>
      saves.push({ reason: e.reason, revision: e.revision }),
    );
    editor.requestSave();
    expect(saves).toEqual([{ reason: "manual", revision: 0 }]);
  });

  it("on() returns an unsubscribe", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const spy = vi.fn();
    const off = editor.on("selection-change", spy);
    editor.select(["a"]);
    off();
    editor.select(["b"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("createSceneEditor — plugins", () => {
  it("installs with context: on, editor API, addDisposer; unuse runs teardown", async () => {
    const { editor, fake } = setup();
    await editor.loadDocument(doc);
    const seen: string[][] = [];
    const disposed = vi.fn();
    const uninstalled = vi.fn();
    const plugin: SceneEditorPlugin = {
      id: "p1",
      install(ctx) {
        ctx.on("selection-change", (p) => seen.push(p.ids));
        ctx.addDisposer(disposed);
        expect(ctx.editor.dirty).toBe(false);
        return uninstalled;
      },
    };
    editor.use(plugin);
    fake.events.emit("selection-change", { ids: ["x"] });
    expect(seen).toEqual([["x"]]);
    editor.unuse("p1");
    expect(uninstalled).toHaveBeenCalledTimes(1);
    expect(disposed).toHaveBeenCalledTimes(1);
    fake.events.emit("selection-change", { ids: ["y"] });
    expect(seen).toEqual([["x"]]);
  });

  it("duplicate plugin id throws; unuse of unknown id is a no-op", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const plugin: SceneEditorPlugin = { id: "dup", install: () => {} };
    editor.use(plugin);
    expect(() => editor.use(plugin)).toThrow(/Duplicate plugin id/);
    editor.unuse("missing");
    expect(() => editor.use({ id: "dup2", install: () => {} })).not.toThrow();
  });

  it("destroy tears down plugins", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    const uninstalled = vi.fn();
    editor.use({ id: "p", install: () => uninstalled });
    editor.destroy();
    expect(uninstalled).toHaveBeenCalledTimes(1);
  });
});

describe("createSceneEditor — keyboard & lifecycle", () => {
  it("handleKeyDown consumes undo/redo combos and G/R/S", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    editor.applyTransform("a", T, { ...T, position: [3, 0, 0] });

    const prevented = vi.fn();
    expect(
      editor.handleKeyDown({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: prevented }),
    ).toBe(true);
    expect(prevented).toHaveBeenCalled();
    expect(editor.canRedo).toBe(true);

    expect(
      editor.handleKeyDown({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe(true);
    expect(editor.canRedo).toBe(false);

    expect(
      editor.handleKeyDown({ key: "g", ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBe(true);
    expect(
      editor.handleKeyDown({ key: "q", ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBe(false);
  });

  it("meta key maps to mod on mac-style events", async () => {
    const { editor } = setup();
    await editor.loadDocument(doc);
    editor.applyTransform("a", T, { ...T, position: [4, 0, 0] });
    expect(
      editor.handleKeyDown({ key: "z", ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBe(true);
    expect(editor.canUndo).toBe(false);
  });

  it("destroy is idempotent; later calls throw lifecycle", async () => {
    const { editor, fake } = setup();
    await editor.loadDocument(doc);
    editor.destroy();
    editor.destroy();
    expect(() => editor.getDocument()).toThrow(SceneEditorError);
    expect(() => editor.select(["a"])).toThrow(/destroyed/i);
    expect(fake.calls.flushDisposers).toBeGreaterThanOrEqual(1);
  });
});
