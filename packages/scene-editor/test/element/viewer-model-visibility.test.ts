// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SceneEditorElement,
  type VisibilityObserverFactory,
} from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { sceneDocument, sceneObject } from "../support/documents";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;
const ORIGINAL_VISIBILITY = SceneEditorElement.visibilityObserverFactory;

const doc = sceneDocument({
  sceneId: "s1",
  objects: [sceneObject({ id: "box-1", name: "Box" })],
});

let report: ((visible: boolean) => void) | null = null;

function installObserver(factory?: VisibilityObserverFactory): void {
  report = null;
  SceneEditorElement.visibilityObserverFactory =
    factory ??
    ((onChange) => {
      report = onChange;
      return { observe: () => {}, disconnect: () => {} };
    });
}

function intersect(visible: boolean): void {
  if (!report) throw new Error("visibility observer was not installed");
  report(visible);
}

function makeElement(markup = ""): { el: SceneEditorElement; fake: FakeRuntime } {
  const fake = new FakeRuntime();
  SceneEditorElement.runtimeFactory = () => fake;
  const el = document.createElement("scene-editor") as SceneEditorElement;
  el.innerHTML = markup;
  return { el, fake };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  installObserver();
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  SceneEditorElement.visibilityObserverFactory = ORIGINAL_VISIBILITY;
});

describe("loaded (model-viewer parity)", () => {
  it("flips on the load event, not on the presence of content", async () => {
    const { el } = makeElement();
    await connected(el);

    expect(el.loaded).toBe(false);
    await el.loadDocument(doc);
    expect(el.loaded).toBe(true);
  });

  it("goes back to false when the element is torn down", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    expect(el.loaded).toBe(true);

    el.remove();
    expect(el.loaded).toBe(false);
  });
});

describe("modelIsVisible (loaded × viewport × poster)", () => {
  it("stays false while intersecting but nothing is loaded", async () => {
    const { el } = makeElement();
    const seen: boolean[] = [];
    el.addEventListener("model-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await connected(el);

    intersect(true);

    // `visibility-change` is the raw crossing and still fires…
    expect(el.visible).toBe(true);
    // …but the model itself is not on screen yet.
    expect(el.modelIsVisible).toBe(false);
    expect(seen).toEqual([]);
  });

  it("announces the composite verdict once the content is in view", async () => {
    const { el } = makeElement();
    const seen: boolean[] = [];
    el.addEventListener("model-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await connected(el);

    await el.loadDocument(doc);
    expect(el.modelIsVisible).toBe(false); // loaded, but still off-screen

    intersect(true);
    expect(el.modelIsVisible).toBe(true);
    expect(seen).toEqual([true]);

    intersect(false);
    expect(seen).toEqual([true, false]);
  });

  it("holds the model hidden behind a poster until it is revealed", async () => {
    const { el } = makeElement(`<div slot="poster">loading…</div>`);
    el.setAttribute("reveal", "manual");
    const seen: boolean[] = [];
    el.addEventListener("model-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await connected(el);

    intersect(true);
    await el.loadDocument(doc);
    expect(el.loaded).toBe(true);
    expect(el.modelIsVisible).toBe(false);
    expect(seen).toEqual([]);

    el.dismissPoster();
    expect(el.modelIsVisible).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("goes invisible again when a poster is added after the load", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadDocument(doc);
    intersect(true);
    expect(el.modelIsVisible).toBe(true);

    const poster = document.createElement("div");
    poster.setAttribute("slot", "poster");
    el.appendChild(poster);
    // Slot collection is observer-driven; let the record flush first.
    await nextTick();

    expect(el.modelIsVisible).toBe(false);
  });

  it("treats a missing IntersectionObserver as visible, like the reference", async () => {
    installObserver(() => null);
    const { el } = makeElement();
    const seen: boolean[] = [];
    el.addEventListener("model-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await connected(el);

    await el.loadDocument(doc);

    expect(el.visible).toBe(false); // no observer, nothing crosses
    expect(el.modelIsVisible).toBe(true);
    expect(seen).toEqual([true]);
  });
});
