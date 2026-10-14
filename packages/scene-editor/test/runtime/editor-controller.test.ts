import { describe, expect, it, vi } from "vitest";
import type { RuntimeContract } from "../../src/runtime/runtime-contract";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { SceneDocument } from "../../src/core/document/schema";

const doc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "s1",
  revision: 0,
  objects: [],
};

describe("RuntimeContract / FakeRuntime", () => {
  it("FakeRuntime satisfies RuntimeContract structurally", () => {
    const runtime: RuntimeContract = new FakeRuntime();
    expect(runtime).toBeDefined();
  });

  it("FakeRuntime records lifecycle calls for assertions", async () => {
    const fake = new FakeRuntime();
    await fake.loadDocument(doc);
    fake.select(["a", "b"]);
    fake.applyTransform("a", {
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(fake.calls.loadDocument).toEqual([doc]);
    expect(fake.calls.select).toEqual([["a", "b"]]);
    expect(fake.calls.applyTransform[0]).toMatchObject({ id: "a" });
  });
});

describe("EditorController", () => {
  it("registers disposers and destroys via LIFO flush", () => {
    const order: string[] = [];
    const controller = new EditorController(new FakeRuntime());
    controller.disposers.add(() => order.push("renderer"));
    controller.disposers.add(() => order.push("loop"));
    controller.destroy();
    expect(order).toEqual(["loop", "renderer"]);
    expect(controller.disposers.size).toBe(0);
  });

  it("destroy with a throwing disposer still flushes the rest", () => {
    const ok = vi.fn();
    const controller = new EditorController(new FakeRuntime());
    controller.disposers.add(ok);
    controller.disposers.add(() => {
      throw new Error("gpu release failed");
    });
    expect(() => controller.destroy()).toThrow("gpu release failed");
    expect(ok).toHaveBeenCalled();
  });

  it("exposes its runtime", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    expect(controller.runtime).toBe(fake);
  });
});
