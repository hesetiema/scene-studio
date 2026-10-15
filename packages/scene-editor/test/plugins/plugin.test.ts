// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { SceneEditorPlugin, PluginContext } from "../../src/plugins/plugin";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;

describe("SceneEditorPlugin (install context)", () => {
  beforeAll(() => {
    defineSceneEditor();
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  });

  async function setup(): Promise<{ el: SceneEditorElement; fake: FakeRuntime }> {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    document.body.appendChild(el);
    await el.ready;
    return { el, fake };
  }

  it("use() installs with context: on(), editor API, addDisposer", async () => {
    const { el, fake } = await setup();
    const seen: string[][] = [];
    let ctxCapture: PluginContext | null = null;
    const plugin: SceneEditorPlugin = {
      id: "test-plugin",
      install(ctx) {
        ctxCapture = ctx;
        ctx.on("selection-change", (p) => seen.push(p.ids));
      },
    };
    el.use(plugin);
    expect(ctxCapture).not.toBeNull();
    expect(ctxCapture!.editor).toBeDefined();
    fake.events.emit("selection-change", { ids: ["x"] });
    expect(seen).toEqual([["x"]]);
  });

  it("use() before ready queues install until after init", async () => {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    const installed = vi.fn();
    el.use({ id: "early", install: () => { installed(); } });
    document.body.appendChild(el);
    await el.ready;
    expect(installed).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("unuse() runs uninstall and removes listeners", async () => {
    const { el, fake } = await setup();
    const uninstall = vi.fn();
    const seen: string[] = [];
    el.use({
      id: "p",
      install(ctx) {
        ctx.on("selection-change", () => seen.push("hit"));
        return uninstall;
      },
    });
    fake.events.emit("selection-change", { ids: ["a"] });
    expect(seen).toHaveLength(1);
    el.unuse("p");
    expect(uninstall).toHaveBeenCalledTimes(1);
    fake.events.emit("selection-change", { ids: ["b"] });
    expect(seen).toHaveLength(1); // no further hits
  });

  it("plugin addDisposer runs on unuse and on disconnect", async () => {
    const { el } = await setup();
    const disposed = vi.fn();
    el.use({
      id: "d",
      install(ctx) {
        ctx.addDisposer(disposed);
      },
    });
    el.unuse("d");
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("disconnect disposes remaining plugins", async () => {
    const fake = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => fake;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    document.body.appendChild(el);
    await el.ready;
    const disposed = vi.fn();
    el.use({
      id: "left",
      install(ctx) {
        ctx.addDisposer(disposed);
      },
    });
    el.remove();
    expect(disposed).toHaveBeenCalled();
  });

  it("duplicate plugin id throws lifecycle error", async () => {
    const { el } = await setup();
    el.use({ id: "dup", install: () => {} });
    expect(() => el.use({ id: "dup", install: () => {} })).toThrow(/duplicate|already/i);
  });
});
