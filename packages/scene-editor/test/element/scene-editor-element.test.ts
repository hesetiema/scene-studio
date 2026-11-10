// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import type { SceneDocument } from "../../src/core/document/schema";
import { sceneDocument, sceneObject } from "../support/documents";
import { createDefaultViewState } from "../../src/core/document/default-view";

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

  it("bridges view-change to a DOM CustomEvent", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument());

    const seen: Array<{ source: string; fov: number }> = [];
    el.addEventListener("view-change", (event) => {
      const detail = (event as CustomEvent<{ source: string; view: { camera: { fov: number } } }>)
        .detail;
      seen.push({ source: detail.source, fov: detail.view.camera.fov });
    });
    const view = createDefaultViewState();
    view.camera.fov = 19;
    fake.simulateViewChange(view);

    expect(seen).toEqual([{ source: "interaction", fov: 19 }]);
    el.remove();
  });
});

describe("SceneEditorElement multi-select surface (facade parity)", () => {
  const multiDoc = sceneDocument({
    objects: [
      sceneObject({ id: "box-1", name: "Box" }),
      sceneObject({ id: "box-2", name: "Box2" }),
      sceneObject({ id: "box-3", name: "Box3" }),
    ],
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  async function setup(): Promise<{ el: SceneEditorElement; fake: FakeRuntime }> {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(multiDoc);
    return { el, fake };
  }

  it("select(ids) sets a multi-selection and broadcasts it", async () => {
    const { el, fake } = await setup();
    const spy = vi.fn();
    el.addEventListener("selection-change", spy);
    el.select(["box-1", "box-2"]);
    expect(el.selectedIds).toEqual(["box-1", "box-2"]);
    expect(fake.calls.select).toContainEqual(["box-1", "box-2"]);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { ids: ["box-1", "box-2"] } }),
    );
  });

  it("addToSelection / removeFromSelection / toggleSelection compose", async () => {
    const { el } = await setup();
    el.select(["box-1"]);
    el.addToSelection(["box-2", "box-3"]);
    expect(el.selectedIds).toEqual(["box-1", "box-2", "box-3"]);

    el.removeFromSelection(["box-2"]);
    expect(el.selectedIds).toEqual(["box-1", "box-3"]);

    el.toggleSelection("box-3");
    el.toggleSelection("box-2");
    expect(el.selectedIds).toEqual(["box-1", "box-2"]);
  });

  it("shift-click on the canvas toggles instead of replacing", async () => {
    const { el, fake } = await setup();
    el.select(["box-1"]);
    fake.pickResult = "box-2";
    const canvas = el.querySelector("canvas")!;
    canvas.dispatchEvent(
      new MouseEvent("click", { clientX: 1, clientY: 1, shiftKey: true, bubbles: true }),
    );
    expect(el.selectedIds).toEqual(["box-1", "box-2"]);

    canvas.dispatchEvent(
      new MouseEvent("click", { clientX: 1, clientY: 1, shiftKey: true, bubbles: true }),
    );
    expect(el.selectedIds).toEqual(["box-1"]);
  });
});

describe("SceneEditorElement viewer attributes (model-viewer parity)", () => {
  const ORIGINAL_VISIBILITY = SceneEditorElement.visibilityObserverFactory;
  let visibilityCallback: ((visible: boolean) => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
    visibilityCallback = null;
    SceneEditorElement.visibilityObserverFactory = (onChange) => {
      visibilityCallback = onChange;
      return { observe: () => {}, disconnect: () => {} };
    };
  });

  afterEach(() => {
    SceneEditorElement.visibilityObserverFactory = ORIGINAL_VISIBILITY;
  });

  function lastItem<T>(list: T[]): T | undefined {
    return list[list.length - 1];
  }

  it("maps min/max-camera-orbit and disable-* onto the runtime", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.setAttribute("min-camera-orbit", "auto 30deg 2m");
    el.setAttribute("max-camera-orbit", "90deg 150deg 20m");
    el.setAttribute("disable-zoom", "");

    const controls = lastItem(fake.calls.setCameraControls);
    expect(controls).toMatchObject({
      pan: true,
      zoom: false,
      limits: { phi: [30, 150], radius: [2, 20] },
    });
    // `auto` on either side leaves that axis unlimited.
    expect(controls?.limits?.theta).toBeUndefined();
  });

  it("parses radians and ignores inverted ranges", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.setAttribute("min-camera-orbit", `-${Math.PI.toFixed(4)}rad auto 1m`);
    el.setAttribute("max-camera-orbit", `${Math.PI.toFixed(3)}rad auto 30m`);

    const limits = lastItem(fake.calls.setCameraControls)?.limits;
    expect(limits?.theta?.[0]).toBeCloseTo(-180);
    expect(limits?.radius).toEqual([1, 30]);
    expect(limits?.phi).toBeUndefined();
  });

  it("maps auto-rotate attributes, and clearing them stops the turntable", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.setAttribute("auto-rotate", "");
    el.setAttribute("rotation-per-second", "45");
    el.setAttribute("auto-rotate-delay", "1500");

    expect(lastItem(fake.calls.setAutoRotate)).toEqual({
      enabled: true,
      degreesPerSecond: 45,
      delayMs: 1500,
    });

    el.removeAttribute("auto-rotate");
    expect(lastItem(fake.calls.setAutoRotate)).toBeNull();
  });

  it("maps camera-damping, keeping 'absent' and 'zero' distinct", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    // Absent = no inertia: a render-on-demand editor stops with the pointer.
    expect(lastItem(fake.calls.setCameraControls)).not.toHaveProperty("damping");

    el.setAttribute("camera-damping", "0.25");
    expect(lastItem(fake.calls.setCameraControls)?.damping).toBe(0.25);

    // A bare attribute means the addon's own default, not zero.
    el.setAttribute("camera-damping", "");
    expect(lastItem(fake.calls.setCameraControls)?.damping).toBeCloseTo(0.08);

    el.setAttribute("camera-damping", "0");
    expect(lastItem(fake.calls.setCameraControls)?.damping).toBe(0);
  });

  it("pauses rendering while off-screen and resumes when it comes back", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    visibilityCallback?.(false);
    expect(lastItem(fake.calls.setRenderingPaused)).toBe(true);

    visibilityCallback?.(true);
    expect(lastItem(fake.calls.setRenderingPaused)).toBe(false);

    // Repeats are de-duplicated before reaching the runtime.
    const count = fake.calls.setRenderingPaused.length;
    visibilityCallback?.(true);
    expect(fake.calls.setRenderingPaused).toHaveLength(count);
  });

  it("maps the playback attributes, converting ms → seconds", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    el.setAttribute("autoplay", "");
    el.setAttribute("animation-name", "Wave");
    el.setAttribute("animation-crossfade-duration", "250");
    el.setAttribute("pause-at-end", "");

    expect(lastItem(fake.calls.setAnimationOptions)).toEqual({
      autoplay: true,
      clipName: "Wave",
      crossfadeSeconds: 0.25,
      pauseAtEnd: true,
    });
  });

  it("disable-tap keeps orbit but never turns a click into a selection", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    fake.pickResult = "box-1";
    el.setAttribute("disable-tap", "");

    const canvas = el.querySelector("canvas")!;
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, bubbles: true }));

    expect(fake.calls.pick).toHaveLength(0);
    expect(el.selectedIds).toEqual([]);
  });

  it("reports model-visibility next to visibility-change", async () => {
    const { el } = makeElement();
    const seen: boolean[] = [];
    el.addEventListener("model-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await connected(el);
    // `model-visibility` is the composite verdict (loaded × in-viewport ×
    // revealed), so there has to be something loaded before it can say true.
    await el.loadDocument(doc);

    visibilityCallback?.(true);
    visibilityCallback?.(false);

    expect(seen).toEqual([true, false]);
  });

  it("defers the src load until first visible with loading=lazy", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "lazy.glb");
    el.setAttribute("loading", "lazy");
    await connected(el);
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(0);

    visibilityCallback?.(true);
    await nextTick();
    expect(fake.calls.loadDocument).toHaveLength(1);
  });

  it("loads eagerly when lazy is switched back to eager", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "lazy.glb");
    el.setAttribute("loading", "lazy");
    await connected(el);
    await nextTick();
    expect(fake.calls.loadDocument).toHaveLength(0);

    el.setAttribute("loading", "eager");
    await nextTick();
    expect(fake.calls.loadDocument).toHaveLength(1);
  });

  it("never clobbers a host document when a lazy preview wakes up", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "lazy.glb");
    el.setAttribute("loading", "lazy");
    await connected(el);
    await nextTick();

    await el.loadDocument(doc);
    visibilityCallback?.(true);
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(1);
    expect(el.getDocument().sceneId).toBe("s1");
  });
});

describe("SceneEditorElement inbound remote updates (D17)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  it("fast-forwards a clean editor when the remote is the next revision", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    const remote = {
      ...doc,
      revision: 1,
      objects: [{ ...doc.objects[0]!, position: [3, 0, 0] as [number, number, number] }],
    };
    await el.applyRemote(remote, { baseRevision: 0 });
    expect(el.revision).toBe(1);
    expect(el.dirty).toBe(false);
    expect(el.getDocument().objects[0]?.position).toEqual([3, 0, 0]);
    expect(fake.calls.loadDocument).toHaveLength(2);
  });

  it("throws a structured conflict when the editor has local edits", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    el.applyTransform("box-1", doc.objects[0]!, {
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const remote = { ...doc, revision: 1 };

    // Documented semantics: conflict is thrown synchronously (see API.md), so
    // hosts wrap the call in try/catch rather than chaining `.catch()`.
    expect(() => el.applyRemote(remote, { baseRevision: 0 })).toThrow(SceneEditorError);
    try {
      el.applyRemote(remote, { baseRevision: 0 });
    } catch (err) {
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Conflict);
      expect((err as SceneEditorError).detail).toMatchObject({
        base: { revision: 0 },
        incoming: { revision: 1 },
        local: { revision: 0 },
      });
    }
    // local edits are never silently dropped
    expect(el.getDocument().objects[0]?.position).toEqual([1, 0, 0]);
    expect(el.dirty).toBe(true);
  });

  it("conflicts when the remote skips revisions", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    expect(() => el.applyRemote({ ...doc, revision: 7 }, { baseRevision: 0 })).toThrow(
      SceneEditorError,
    );
  });
});

describe("SceneEditorElement slots (model-viewer parity)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  function posterOf(el: SceneEditorElement): HTMLElement {
    return el.querySelector<HTMLElement>('[slot="poster"]')!;
  }

  it("keeps the poster for reveal=manual until dismissPoster()", async () => {
    const { el } = makeElement();
    el.setAttribute("reveal", "manual");
    el.innerHTML = '<div slot="poster">loading…</div>';
    const spy = vi.fn();
    el.addEventListener("poster-dismissed", spy);

    await connected(el);
    const poster = posterOf(el);
    expect(poster.style.display).not.toBe("none");
    expect(poster.style.position).toBe("absolute");

    await el.loadDocument(doc);
    expect(poster.style.display).not.toBe("none");
    expect(spy).not.toHaveBeenCalled();

    el.dismissPoster();
    expect(poster.style.display).toBe("none");
    expect(spy).toHaveBeenCalledTimes(1);

    // Idempotent: a second call must not re-announce.
    el.dismissPoster();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("dismisses the poster after load by default (reveal=auto)", async () => {
    const { el } = makeElement();
    el.innerHTML = '<div slot="poster">loading…</div>';
    const spy = vi.fn();
    el.addEventListener("poster-dismissed", spy);

    await connected(el);
    await el.loadDocument(doc);

    expect(posterOf(el).style.display).toBe("none");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cross-fades the poster with seamless-poster instead of cutting to it", async () => {
    const { el } = makeElement();
    el.setAttribute("seamless-poster", "");
    el.innerHTML = '<div slot="poster">loading…</div>';
    const spy = vi.fn();
    el.addEventListener("poster-dismissed", spy);

    await connected(el);
    await el.loadDocument(doc);

    const poster = posterOf(el);
    // The node stays mounted but transparent: the first frame dissolves
    // through it instead of replacing it in one frame.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(poster.style.display).not.toBe("none");
    expect(poster.style.opacity).toBe("0");
    expect(poster.style.transition).toContain("opacity");
    // Passive while fading — the model behind is already interactive.
    expect(poster.style.pointerEvents).toBe("none");
  });

  it("unmounts the faded poster once the transition ends", async () => {
    const { el } = makeElement();
    el.setAttribute("seamless-poster", "");
    el.innerHTML = '<div slot="poster">loading…</div>';

    // Timers faked up-front: the fade is scheduled during `loadDocument`.
    vi.useFakeTimers();
    try {
      await connected(el);
      await el.loadDocument(doc);
      const poster = posterOf(el);
      expect(poster.style.display).not.toBe("none");

      await vi.advanceTimersByTimeAsync(400);

      expect(poster.style.display).toBe("none");
      // The host's own inline opacity comes back with the node.
      expect(poster.style.opacity).toBe("");
      expect(poster.style.transition).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the fade cancellation honest when a new poster replaces it", async () => {
    const { el } = makeElement();
    el.setAttribute("seamless-poster", "");
    el.innerHTML = '<div slot="poster">loading…</div>';

    await connected(el);
    await el.loadDocument(doc);
    const first = posterOf(el);
    expect(first.style.opacity).toBe("0");

    // A replacement poster starts a fresh reveal cycle.
    first.remove();
    const second = document.createElement("div");
    second.setAttribute("slot", "poster");
    second.style.opacity = "0.5";
    el.appendChild(second);
    await nextTick();

    expect(second.style.display).not.toBe("none");
    // Its own inline opacity survives; the cancelled fade no longer fires.
    expect(second.style.opacity).toBe("0.5");
  });

  it("waits for the first gesture with reveal=interaction", async () => {
    const { el } = makeElement();
    el.setAttribute("reveal", "interaction");
    el.innerHTML = '<div slot="poster">loading…</div>';
    const spy = vi.fn();
    el.addEventListener("poster-dismissed", spy);

    await connected(el);
    await el.loadDocument(doc);
    const poster = posterOf(el);
    expect(poster.style.display).not.toBe("none");

    el.dispatchEvent(new Event("pointerdown"));
    expect(poster.style.display).toBe("none");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("adopts slot nodes added later and releases their styles on removal", async () => {
    const { el } = makeElement();
    el.setAttribute("reveal", "manual");
    await connected(el);

    const poster = document.createElement("div");
    poster.setAttribute("slot", "poster");
    poster.style.display = "flex";
    el.appendChild(poster);
    el.refreshSlots();

    expect(poster.style.position).toBe("absolute");
    expect(poster.style.display).toBe("flex");

    poster.remove();
    await nextTick();
    // Departed nodes get their own inline CSS back.
    expect(poster.style.position).toBe("");
  });

  it("shows slot=progress-bar only while a load is in flight", async () => {
    class GatedRuntime extends FakeRuntime {
      #pending: Array<() => void> = [];
      get pendingCount(): number {
        return this.#pending.length;
      }
      loadDocument(input: SceneDocument): Promise<void> {
        this.calls.loadDocument.push(input);
        return new Promise<void>((resolve) => {
          this.#pending.push(resolve);
        });
      }
      finish(): void {
        for (const resolve of this.#pending.splice(0)) resolve();
      }
    }

    const gated = new GatedRuntime();
    SceneEditorElement.runtimeFactory = () => gated;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    el.innerHTML = '<div slot="progress-bar">0%</div>';
    await connected(el);
    const bar = el.querySelector<HTMLElement>('[slot="progress-bar"]')!;

    expect(bar.style.display).toBe("none");

    const loading = el.loadDocument(doc);
    expect(bar.style.display).not.toBe("none");

    // The facade validates before reaching the runtime; wait for that hop.
    while (gated.pendingCount === 0) await nextTick();
    expect(bar.style.display).not.toBe("none");

    gated.finish();
    await loading;
    expect(bar.style.display).toBe("none");
  });

  it("projects hotspot anchors onto the canvas and hides them behind the camera", async () => {
    class ProjectingRuntime extends FakeRuntime {
      projectPoint(
        point: readonly [number, number, number],
      ): { x: number; y: number; visible: boolean } {
        return { x: point[0] * 10, y: point[1] * 10, visible: point[0] >= 0 };
      }
    }

    const projecting = new ProjectingRuntime();
    SceneEditorElement.runtimeFactory = () => projecting;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    el.innerHTML = `
      <div slot="hotspot-a" data-position="2 3 0">A</div>
      <div slot="hotspot-b" data-position="-1 0 0">B</div>
    `;
    await connected(el);

    const [hotspotA, hotspotB] = Array.from(
      el.querySelectorAll<HTMLElement>('[slot^="hotspot-"]'),
    );
    expect(hotspotA?.style.transform).toContain("translate(20px, 30px)");
    expect(hotspotA?.style.transform).toContain("translate(-50%, -50%)");
    expect(hotspotB?.style.visibility).toBe("hidden");

    projecting.simulateCameraChange(el.getViewState().camera);
    expect(hotspotA?.style.transform).toContain("translate(20px, 30px)");
  });
});

describe("SceneEditorElement capture surface (model-viewer parity)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  class CaptureRuntime extends FakeRuntime {
    dimensions(): { width: number; height: number; depth: number } {
      return { width: 2, height: 4, depth: 6 };
    }
    positionAndNormalFromPoint(): {
      position: [number, number, number];
      normal: [number, number, number];
    } {
      return { position: [0, 0, 0], normal: [0, 1, 0] };
    }
    toDataURL(type = "image/png"): string {
      return `data:${type};base64,AA`;
    }
    toBlob(): Promise<Blob | null> {
      return Promise.resolve(null);
    }
    exportScene(options: { binary?: boolean } = {}): Promise<ArrayBuffer | string> {
      return Promise.resolve(options.binary === false ? "{}" : "glb");
    }
  }

  it("delegates dimensions, picking, capture and export to the runtime", async () => {
    const capture = new CaptureRuntime();
    SceneEditorElement.runtimeFactory = () => capture;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    await connected(el);

    expect(el.getDimensions()).toEqual({ width: 2, height: 4, depth: 6 });
    expect(el.positionAndNormalFromPoint(1, 2)).toEqual({
      position: [0, 0, 0],
      normal: [0, 1, 0],
    });
    expect(await el.toDataURL()).toBe("data:image/png;base64,AA");
    expect(await el.toDataURL("image/jpeg", 0.5)).toBe("data:image/jpeg;base64,AA");
    expect(await el.toBlob()).toBeNull();
    expect(await el.exportScene()).toBe("glb");
    expect(await el.exportScene({ binary: false })).toBe("{}");
  });

  it("degrades gracefully when the runtime lacks the capability", async () => {
    const { el } = makeElement();
    await connected(el);

    expect(el.getDimensions()).toEqual({ width: 0, height: 0, depth: 0 });
    expect(el.positionAndNormalFromPoint(0, 0)).toBeNull();
    await expect(el.toDataURL()).rejects.toBeInstanceOf(SceneEditorError);
    await expect(el.toBlob()).rejects.toMatchObject({ code: SceneErrorCode.Lifecycle });
    await expect(el.exportScene()).rejects.toMatchObject({ code: SceneErrorCode.Lifecycle });
  });
});
