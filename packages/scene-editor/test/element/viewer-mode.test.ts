// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import type { RuntimeFactoryOptions } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { SRC_ASSET_ID } from "../../src/element/src-document";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { AssetResolver } from "../../src/assets/resolver-asset-loader";
import { sceneDocument } from "../support/documents";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  el: SceneEditorElement;
  fake: FakeRuntime;
  options: () => RuntimeFactoryOptions | undefined;
  resolver: () => AssetResolver | undefined;
}

function makeElement(): Harness {
  const fake = new FakeRuntime();
  let captured: RuntimeFactoryOptions | undefined;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options;
    return fake;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return {
    el,
    fake,
    options: () => captured,
    resolver: () => captured?.assetResolver,
  };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

/** Viewer-mode click: the canvas is the surface a user actually clicks. */
function clickCanvas(el: SceneEditorElement): void {
  const canvas = el.querySelector("canvas");
  if (!canvas) throw new Error("canvas missing");
  canvas.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 20, bubbles: true }));
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  vi.restoreAllMocks();
});

describe("<scene-editor mode>", () => {
  it("treats a src preview as a viewer", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "https://cdn.test/robot.glb");
    await connected(el);

    expect(el.mode).toBe("viewer");
    expect(el.getAttribute("data-mode")).toBe("viewer");
    expect(fake.calls.setInteractive).toEqual([false]);
    expect(el.selectedIds).toEqual([]);
  });

  it("treats a host document as an editor", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));

    expect(el.mode).toBe("editor");
    expect(el.getAttribute("data-mode")).toBe("editor");
    expect(fake.calls.setInteractive.at(-1)).toBe(true);
  });

  it("does not flip to viewer when src changes after connect", async () => {
    const { el, fake } = makeElement();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));
    fake.calls.setInteractive.length = 0;

    el.setAttribute("src", "a.glb");
    await nextTick();

    expect(el.mode).toBe("editor");
    expect(fake.calls.setInteractive).not.toContain(false);
  });

  it("honours an explicit mode over the derived one", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("mode", "viewer");
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));

    expect(el.mode).toBe("viewer");
    expect(fake.calls.setInteractive.at(-1)).toBe(false);
  });

  it("re-applies interactive when the attribute changes", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    await connected(el);
    fake.calls.setInteractive.length = 0;

    el.setAttribute("mode", "editor");
    expect(el.mode).toBe("editor");
    expect(fake.calls.setInteractive).toEqual([true]);

    el.setAttribute("mode", "viewer");
    expect(fake.calls.setInteractive).toEqual([true, false]);
  });
});

describe("viewer has no selection interaction", () => {
  it("does not pick or select on a canvas click", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    fake.pickResult = SRC_ASSET_ID;
    await connected(el);
    await nextTick();

    clickCanvas(el);

    expect(fake.calls.pick).toEqual([]);
    expect(fake.calls.select).toEqual([]);
    expect(el.selectedIds).toEqual([]);
  });

  it("keeps click-to-select on an editor", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));
    fake.pickResult = "box-1";

    clickCanvas(el);

    expect(fake.calls.select).toContainEqual(["box-1"]);
  });

  it("drops the selection when switching to viewer", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadDocument(sceneDocument({ sceneId: "s-1" }));
    el.selectObject("box-1");
    fake.calls.clearSelection = 0;

    el.setAttribute("mode", "viewer");

    expect(fake.calls.clearSelection).toBeGreaterThanOrEqual(1);
  });
});

describe("src preview lifecycle", () => {
  it("keeps the reserved src resolver installed for a declared src", async () => {
    // The resolver is built once during #init; the URL it serves must be the
    // one declared before connect (a late `src` is no longer a load trigger).
    const { el, resolver } = makeElement();
    el.setAttribute("src", "https://cdn.test/robot.glb");
    await connected(el);

    const assetResolver = resolver();
    expect(assetResolver).toBeDefined();
    await expect(assetResolver!.resolve(SRC_ASSET_ID)).resolves.toBe(
      "https://cdn.test/robot.glb",
    );
  });

  it("does not load a model when src arrives after ready", async () => {
    const { el, fake } = makeElement();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await connected(el);
    el.setAttribute("src", "https://cdn.test/late.glb");
    await nextTick();

    expect(fake.calls.loadDocument).toHaveLength(0);
  });

  it("dispatches load only after the preview is framed", async () => {
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    const framedAtLoad: number[] = [];
    el.addEventListener("load", () => {
      framedAtLoad.push(fake.calls.frameViewer);
    });

    await connected(el);
    await nextTick();

    expect(framedAtLoad).toEqual([1]);
  });

  it("dispatches exactly one load carrying the declared url", async () => {
    // The counter (not a boolean) keeps the held `load` from being released
    // before framing finished, and from firing twice for one declaration.
    const { el, fake } = makeElement();
    el.setAttribute("src", "a.glb");
    const urls: Array<string | null> = [];
    el.addEventListener("load", (event) => {
      urls.push((event as CustomEvent<{ url: string | null }>).detail.url);
    });

    await connected(el);
    await nextTick();
    await nextTick();

    expect(urls).toEqual(["a.glb"]);
    expect(el.getAttribute("data-mode")).toBe("viewer");
    expect(fake.calls.frameViewer).toBeGreaterThanOrEqual(1);
  });
});

describe("failure surface", () => {
  it("shows the host's slot=\"error\" node only after a failure", async () => {
    const { el, fake } = makeElement();
    const errorNode = document.createElement("div");
    errorNode.setAttribute("slot", "error");
    errorNode.textContent = "模型加载失败";
    el.appendChild(errorNode);

    await connected(el);
    expect(errorNode.style.display).toBe("none");

    fake.events.emit("error", { code: "asset-load-failed", message: "404" });
    expect(errorNode.style.display).not.toBe("none");
  });

  it("falls back to a built-in message when the host supplies no slot", async () => {
    const { el, fake } = makeElement();
    await connected(el);

    fake.events.emit("error", { code: "render-init-failed", message: "WebGL2 unavailable" });

    const overlay = el.querySelector("[data-scene-editor-error]");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toBe("WebGL2 unavailable");
    expect((overlay as HTMLElement).style.display).not.toBe("none");
  });

  it("clears the failure state on the next load", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    fake.events.emit("error", { code: "asset-load-failed", message: "404" });
    const overlay = el.querySelector("[data-scene-editor-error]") as HTMLElement;
    expect(overlay.style.display).not.toBe("none");

    await el.loadDocument(sceneDocument({ sceneId: "s-2" }));

    expect(overlay.style.display).toBe("none");
  });

  it("does not announce load when the preview asset failed", async () => {
    // A `src` document is one asset, so the runtime's "skip the broken object,
    // keep the rest" rule leaves an empty scene: `load` would tell the host to
    // frame nothing, and it would wipe the error overlay on the way out.
    const { el, fake } = makeElement();
    el.setAttribute("src", "broken.glb");
    const loads: number[] = [];
    el.addEventListener("load", () => loads.push(1));
    // Simulate a one-asset preview whose asset failed: the runtime reports the
    // error *before* the load edge, which is what sets the preview failure flag.
    fake.loadDocument = async (doc) => {
      fake.calls.loadDocument.push(doc);
      fake.events.emit("error", { code: "asset-load-failed", message: "404 Decoder" });
      fake.events.emit("load", { sceneId: doc.sceneId });
    };
    await connected(el);
    await nextTick();
    await nextTick();

    expect(loads).toEqual([]);
    expect(el.loaded).toBe(false);
    const overlay = el.querySelector("[data-scene-editor-error]") as HTMLElement;
    expect(overlay.textContent).toBe("404 Decoder");
    expect(overlay.style.display).not.toBe("none");
  });

  it("still announces load for a host document with one failed asset", async () => {
    // Multi-object documents keep partial-success semantics: the surviving
    // objects are worth rendering, so the load is still a load.
    const { el, fake } = makeElement();
    await connected(el);
    fake.events.emit("error", { code: "asset-load-failed", message: "404" });
    const loads: number[] = [];
    el.addEventListener("load", () => loads.push(1));

    await el.loadDocument(sceneDocument({ sceneId: "s-2" }));

    expect(loads).toHaveLength(1);
    expect(el.loaded).toBe(true);
  });
});
