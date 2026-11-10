// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

/**
 * A runtime that can answer the `data-normal` question.
 *
 * `facing` is the verdict it will hand back, so a test can flip it and watch the
 * element restyle the anchor — the real test (`projectHotspot`) lives in
 * `test/three/hotspot-projection.test.ts`, which owns actual camera math.
 */
class FacingRuntime extends FakeRuntime {
  facing = true;
  readonly hotspotCalls: Array<{
    point: readonly [number, number, number];
    normal: readonly [number, number, number];
  }> = [];

  projectHotspot(
    point: readonly [number, number, number],
    normal: readonly [number, number, number],
  ): { x: number; y: number; z: number; visible: boolean; facingCamera: boolean } {
    this.hotspotCalls.push({ point: [...point], normal: [...normal] });
    return {
      x: point[0] * 10,
      y: point[1] * 10,
      z: 0.5,
      visible: point[0] >= 0,
      facingCamera: this.facing,
    };
  }
}

/** Older runtime: projection only, so `facingCamera` has to be assumed. */
class FlatRuntime extends FakeRuntime {
  projectPoint(
    point: readonly [number, number, number],
  ): { x: number; y: number; visible: boolean } {
    return { x: point[0] * 10, y: point[1] * 10, visible: true };
  }
}

async function mount(runtime: FakeRuntime, markup: string): Promise<SceneEditorElement> {
  SceneEditorElement.runtimeFactory = () => runtime;
  const el = document.createElement("scene-editor") as SceneEditorElement;
  el.innerHTML = markup;
  document.body.appendChild(el);
  await el.ready;
  return el;
}

function anchor(el: SceneEditorElement, name: string): HTMLElement {
  const node = el.querySelector<HTMLElement>(`[slot="${name}"]`);
  if (!node) throw new Error(`no anchor named ${name}`);
  return node;
}

/** The camera-change seam is what re-projects anchors. */
function moveCamera(el: SceneEditorElement, runtime: FakeRuntime): void {
  runtime.simulateCameraChange(el.getViewState().camera);
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
});

describe("SceneEditorElement queryHotspot (model-viewer parity)", () => {
  it("reports position, normal, canvas position and facing", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-jaw" data-position="2 3 0" data-normal="0 0 1">jaw</div>`,
    );

    const data = el.queryHotspot("hotspot-jaw");
    expect(data).not.toBeNull();
    expect(data?.position).toEqual({ x: 2, y: 3, z: 0 });
    expect(data?.normal).toEqual({ x: 0, y: 0, z: 1 });
    // Canvas pixels, plus the NDC depth model-viewer keeps in `z`.
    expect(data?.canvasPosition).toEqual({ x: 20, y: 30, z: 0.5 });
    expect(data?.facingCamera).toBe(true);
  });

  it("returns null for a slot name no anchor carries", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-jaw" data-position="0 0 0">jaw</div>`);

    expect(el.queryHotspot("hotspot-nose")).toBeNull();
  });

  it("reads the live verdict rather than the one from mount time", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-a" data-position="1 1 0">a</div>`);

    runtime.facing = false;
    expect(el.queryHotspot("hotspot-a")?.facingCamera).toBe(false);
  });

  it("assumes facing when the runtime cannot test a normal", async () => {
    const runtime = new FlatRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 2 0" data-normal="0 0 -1">a</div>`,
    );

    const data = el.queryHotspot("hotspot-a");
    expect(data?.facingCamera).toBe(true);
    expect(data?.canvasPosition).toEqual({ x: 10, y: 20, z: 0 });
    // The declared normal is still reported as declared.
    expect(data?.normal).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe("SceneEditorElement data-normal dimming", () => {
  it("defaults the normal to +Y, model-viewer's own default", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-a" data-position="1 1 0">a</div>`);

    moveCamera(el, runtime);
    expect(runtime.hotspotCalls.at(-1)?.normal).toEqual([0, 1, 0]);
  });

  it("dims a back-facing anchor with --min-hotspot-opacity", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 0 1">a</div>`,
    );
    const node = anchor(el, "hotspot-a");

    // Front-facing leaves opacity to the host (no inline value at all).
    expect(node.style.opacity).toBe("");

    runtime.facing = false;
    moveCamera(el, runtime);
    expect(node.style.opacity).toBe("var(--min-hotspot-opacity, 0.25)");

    runtime.facing = true;
    moveCamera(el, runtime);
    expect(node.style.opacity).toBe("");
  });

  it("announces the verdict once per change, not once per frame", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 0 1">a</div>`,
    );
    const node = anchor(el, "hotspot-a");
    const seen: boolean[] = [];
    node.addEventListener("hotspot-visibility", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });

    moveCamera(el, runtime);
    expect(seen).toEqual([]); // still facing: nothing changed

    runtime.facing = false;
    moveCamera(el, runtime);
    moveCamera(el, runtime);
    moveCamera(el, runtime);
    expect(seen).toEqual([false]);

    runtime.facing = true;
    moveCamera(el, runtime);
    expect(seen).toEqual([false, true]);
  });

  it("mirrors the verdict onto data-<visibility-attribute> when asked", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 0 1"
            data-visibility-attribute="visible">a</div>`,
    );
    const node = anchor(el, "hotspot-a");

    moveCamera(el, runtime);
    expect(node.hasAttribute("data-visible")).toBe(true);

    runtime.facing = false;
    moveCamera(el, runtime);
    expect(node.hasAttribute("data-visible")).toBe(false);
  });

  it("leaves nodes without the opt-in attribute untouched", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 0 1">a</div>`,
    );
    const node = anchor(el, "hotspot-a");

    runtime.facing = false;
    moveCamera(el, runtime);
    expect(node.hasAttribute("data-visible")).toBe(false);
    expect(node.attributes.getNamedItem("data-visible")).toBeNull();
  });

  it("re-reads data-normal when the attribute changes", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 0 1">a</div>`,
    );
    const node = anchor(el, "hotspot-a");

    node.setAttribute("data-normal", "0 0 -1");
    // Slot collection is observer-driven; let the record flush first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    moveCamera(el, runtime);
    expect(runtime.hotspotCalls.at(-1)?.normal).toEqual([0, 0, -1]);
  });

  it("hides an anchor that leaves the depth range regardless of facing", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="-1 1 0" data-normal="0 0 1">a</div>`,
    );
    const node = anchor(el, "hotspot-a");

    moveCamera(el, runtime);
    expect(node.style.visibility).toBe("hidden");
  });
});

describe("SceneEditorElement updateHotspot (model-viewer parity)", () => {
  it("moves the anchor without rewriting its attributes", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-a" data-position="1 1 0">a</div>`);
    const node = anchor(el, "hotspot-a");

    el.updateHotspot({ name: "hotspot-a", position: "2 3 0" });

    // Re-projected immediately, and the DOM is the host's, not ours to edit.
    expect(node.style.transform).toBe("translate(-50%, -50%) translate(20px, 30px)");
    expect(node.getAttribute("data-position")).toBe("1 1 0");
    expect(el.queryHotspot("hotspot-a")?.position).toEqual({ x: 2, y: 3, z: 0 });
  });

  it("leaves the fields it was not given alone", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 1 0" data-normal="0 1 0">a</div>`,
    );

    el.updateHotspot({ name: "hotspot-a", normal: "0 0 -1" });
    moveCamera(el, runtime);

    expect(runtime.hotspotCalls.at(-1)?.normal).toEqual([0, 0, -1]);
    expect(runtime.hotspotCalls.at(-1)?.point).toEqual([1, 1, 0]);
  });

  it("accepts unit suffixes, like data-position does", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-a" data-position="0 0 0">a</div>`);

    el.updateHotspot({ name: "hotspot-a", position: "1m 2m 3m" });
    expect(el.queryHotspot("hotspot-a")?.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("moves every node that shares the slot name", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(
      runtime,
      `<div slot="hotspot-a" data-position="1 0 0">first</div>
       <div slot="hotspot-a" data-position="2 0 0">second</div>`,
    );

    el.updateHotspot({ name: "hotspot-a", position: "5 5 0" });
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[slot="hotspot-a"]'));
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.style.transform).toBe("translate(-50%, -50%) translate(50px, 50px)");
    }
  });

  it("is a silent no-op for an unknown name or an unusable value", async () => {
    const runtime = new FacingRuntime();
    const el = await mount(runtime, `<div slot="hotspot-a" data-position="1 1 0">a</div>`);
    const before = el.queryHotspot("hotspot-a")?.position;

    expect(() => el.updateHotspot({ name: "hotspot-nope", position: "9 9 9" })).not.toThrow();
    // Garbage must not throw either: this is fed straight from host input.
    el.updateHotspot({ name: "hotspot-a", position: "left right up" });
    // `surface` is accepted for signature compatibility and ignored.
    el.updateHotspot({ name: "hotspot-a", surface: "0.5 0.5 0" });

    expect(el.queryHotspot("hotspot-a")?.position).toEqual(before);
  });
});
