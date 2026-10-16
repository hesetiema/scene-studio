// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import type { SceneDocument } from "../../src/core/document/schema";
import { sceneDocument, sceneObject } from "../support/documents";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

const doc = sceneDocument({
  sceneId: "s1",
  objects: [sceneObject({ id: "box-1", name: "Box" })],
});

function makeElement(): { el: SceneEditorElement; fake: FakeRuntime } {
  const fake = new FakeRuntime();
  SceneEditorElement.runtimeFactory = () => fake;
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeAll(() => {
  defineSceneEditor();
});

describe("defineSceneEditor", () => {
  it("is idempotent — second call does not throw", () => {
    expect(() => defineSceneEditor()).not.toThrow();
    expect(customElements.get("scene-editor")).toBeDefined();
  });
});

describe("SceneEditorElement lifecycle (D20 upgrade + ready)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  it("ready resolves after connect and scene-ready fires", async () => {
    const { el } = makeElement();
    const readySpy = vi.fn();
    el.addEventListener("scene-ready", readySpy);
    await connected(el);
    expect(readySpy).toHaveBeenCalledTimes(1);
    await expect(el.ready).resolves.toBeUndefined();
  });

  it("ready rejects and error event fires when runtime init fails (D6)", async () => {
    SceneEditorElement.runtimeFactory = () => {
      throw new SceneEditorError(SceneErrorCode.RenderInitFailed, "no gpu");
    };
    const el = document.createElement("scene-editor") as SceneEditorElement;
    const errorSpy = vi.fn();
    el.addEventListener("error", errorSpy);
    document.body.appendChild(el);
    await expect(el.ready).rejects.toMatchObject({
      code: SceneErrorCode.RenderInitFailed,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      detail: { code: "render-init-failed", message: "no gpu" },
    });
  });

  it("attributes present before upgrade are honored (upgrade contract)", async () => {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    document.body.innerHTML = `<scene-editor project-id="p-9" renderer="webgl2"></scene-editor>`;
    const el = document.querySelector("scene-editor") as SceneEditorElement;
    await el.ready;
    expect(el.getAttribute("project-id")).toBe("p-9");
    expect(fake.calls.loadDocument).toBeDefined();
  });

  it("disconnect destroys controller (no throw on double disconnect)", async () => {
    const { el } = makeElement();
    await connected(el);
    el.remove();
    await nextTick();
    expect(() => el.remove()).not.toThrow();
  });

  it("reconnect after disconnect re-initializes", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    el.remove();
    await nextTick();
    const fake2 = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake2;
    document.body.appendChild(el);
    await el.ready;
    await el.loadDocument(doc);
    expect(fake2.calls.loadDocument).toHaveLength(1);
    expect(fake.calls.loadDocument).toHaveLength(0);
  });
});

describe("SceneEditorElement API and events (D18)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  it("loadDocument + getDocument roundtrip", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    expect(el.getDocument()).toEqual(doc);
  });

  it("selectObject broadcasts selection-change custom event", async () => {
    const { el } = makeElement();
    const spy = vi.fn();
    el.addEventListener("selection-change", spy);
    await connected(el);
    el.selectObject("box-1");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { ids: ["box-1"] } }),
    );
  });

  it("undo/redo via keyboard only when element focused (D20 focus domain)", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    const from = doc.objects[0]!;
    el.applyTransform("box-1", from, {
      position: [2, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(el.getDocument().objects[0]?.position).toEqual([2, 0, 0]);

    el.blur();
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    expect(el.getDocument().objects[0]?.position).toEqual([2, 0, 0]);

    el.focus();
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    expect(el.getDocument().objects[0]?.position).toEqual([0, 0, 0]);

    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(el.getDocument().objects[0]?.position).toEqual([2, 0, 0]);
  });

  it("history-change and document-dirty surface as custom events", async () => {
    const { el } = makeElement();
    const historySpy = vi.fn();
    const dirtySpy = vi.fn();
    el.addEventListener("history-change", historySpy);
    el.addEventListener("document-dirty", dirtySpy);
    await connected(el);
    await el.loadDocument(doc);
    el.applyTransform("box-1", doc.objects[0]!, {
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(historySpy).toHaveBeenCalled();
    expect(dirtySpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { dirty: true } }),
    );
  });

  it("requestSave dispatches save-request (authoritative save path, D18)", async () => {
    const { el } = makeElement();
    const spy = vi.fn();
    el.addEventListener("save-request", spy);
    await connected(el);
    await el.loadDocument(doc);
    el.requestSave();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("save-request detail carries document and revision (D18)", async () => {
    const { el } = makeElement();
    const spy = vi.fn();
    el.addEventListener("save-request", spy);
    await connected(el);
    await el.loadDocument(doc);
    el.requestSave();
    const detail = spy.mock.calls[0]![0] as CustomEvent;
    expect(detail.detail).toMatchObject({ reason: "manual", revision: 0 });
    expect((detail.detail as { document: SceneDocument }).document.sceneId).toBe("s1");
  });

  it("exposes revision and dirty; markSaved adopts server revision and clears dirty", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    expect(el.revision).toBe(0);
    expect(el.dirty).toBe(false);
    el.applyTransform("box-1", doc.objects[0]!, {
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(el.dirty).toBe(true);
    el.markSaved(1);
    expect(el.revision).toBe(1);
    expect(el.dirty).toBe(false);
    expect(el.getDocument().revision).toBe(1);
  });

  it("has tabindex for focus domain by default", async () => {
    const { el } = makeElement();
    await connected(el);
    expect(el.getAttribute("tabindex")).toBe("0");
  });
});

describe("SceneEditorElement thin shell (0.2 — delegates to the headless facade)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  it("executeCommand enters the shared history and is undoable via the element", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    let counter = 0;
    el.executeCommand({
      label: "host:increment",
      execute: () => {
        counter = 1;
      },
      undo: () => {
        counter = 0;
      },
    });
    expect(counter).toBe(1);
    el.undo();
    expect(counter).toBe(0);
  });

  it("loadDocument failure rejects and surfaces an error event (facade bridge)", async () => {
    const { el } = makeElement();
    const errorSpy = vi.fn();
    el.addEventListener("error", errorSpy);
    await connected(el);
    await expect(el.loadDocument({ schemaVersion: 1 })).rejects.toBeInstanceOf(SceneEditorError);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      code: "validation",
    });
  });

  it("plugin teardown failure surfaces through the shared PluginHost as an error event", async () => {
    const { el } = makeElement();
    const errorSpy = vi.fn();
    el.addEventListener("error", errorSpy);
    await connected(el);
    el.use({
      id: "bad-disposer",
      install: (ctx) => {
        ctx.addDisposer(() => {
          throw new Error("boom");
        });
      },
    });
    el.unuse("bad-disposer");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      message: "Plugin disposer failed",
    });
  });

  it("disconnect performs full runtime teardown (flushDisposers)", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    el.remove();
    await nextTick();
    expect(fake.calls.flushDisposers).toBeGreaterThanOrEqual(1);
  });
});
