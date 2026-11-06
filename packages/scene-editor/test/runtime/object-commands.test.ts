import { beforeEach, describe, expect, it } from "vitest";
import { createSceneEditor, type SceneEditor } from "../../src/runtime/create-scene-editor";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { sceneDocument, sceneObject } from "../support/documents";

let runtime: FakeRuntime;
let editor: SceneEditor;

function ids(): string[] {
  return editor.getDocument().objects.map((object) => object.id);
}

function findBy(id: string) {
  return editor.getDocument().objects.find((object) => object.id === id);
}

beforeEach(async () => {
  runtime = new FakeRuntime();
  editor = createSceneEditor({ runtime });
  await editor.loadDocument(
    sceneDocument({ objects: [sceneObject({ id: "box" })] }),
  );
});

describe("addObject", () => {
  it("mounts once, appends to the document and rejoins on redo", async () => {
    const dto = sceneObject({ id: "added", type: "primitive", geometry: { kind: "box" } });

    await editor.addObject(dto);

    expect(ids()).toEqual(["box", "added"]);
    // The controller mounts before the command, so the first execute must not
    // mount a second time.
    expect(runtime.calls.addObject).toHaveLength(1);

    expect(editor.undo()).toBe(true);
    expect(ids()).toEqual(["box"]);
    expect(runtime.calls.removeObject).toEqual(["added"]);

    expect(editor.redo()).toBe(true);
    expect(ids()).toEqual(["box", "added"]);
    expect(runtime.calls.addObject).toHaveLength(2);
  });

  it("rejects a duplicate id without touching the runtime", async () => {
    await expect(editor.addObject(sceneObject({ id: "box" }))).rejects.toThrow(/Duplicate/);
    expect(runtime.calls.addObject).toHaveLength(0);
  });

  it("rejects a missing parent", async () => {
    await expect(
      editor.addObject(sceneObject({ id: "orphan", parentId: "ghost" })),
    ).rejects.toThrow(/missing parentId/);
    expect(ids()).toEqual(["box"]);
  });

  it("rejects a primitive without geometry (schema, not just types)", async () => {
    await expect(
      editor.addObject({ ...sceneObject({ id: "bad" }), type: "primitive" } as never),
    ).rejects.toThrow();
    expect(ids()).toEqual(["box"]);
  });

  it("reports a lifecycle error when the runtime cannot mount incrementally", async () => {
    Object.defineProperty(runtime, "addObject", { value: undefined });
    await expect(
      editor.addObject(sceneObject({ id: "added", type: "primitive", geometry: { kind: "box" } })),
    ).rejects.toThrow(/does not support addObject/);
  });
});

describe("removeObject", () => {
  beforeEach(async () => {
    await editor.loadDocument(
      sceneDocument({
        objects: [
          sceneObject({ id: "box" }),
          sceneObject({ id: "grp", type: "group" }),
          sceneObject({ id: "child1", type: "primitive", geometry: { kind: "box" }, parentId: "grp" }),
          sceneObject({ id: "child2", type: "primitive", geometry: { kind: "box" }, parentId: "child1" }),
        ],
      }),
    );
  });

  it("removes the whole subtree children-first", () => {
    editor.removeObject("grp");

    expect(ids()).toEqual(["box"]);
    expect(runtime.calls.removeObject).toEqual(["child2", "child1", "grp"]);
  });

  it("restores the original array order on undo", () => {
    editor.removeObject("grp");
    expect(editor.undo()).toBe(true);

    expect(ids()).toEqual(["box", "grp", "child1", "child2"]);
    expect(findBy("child2")?.parentId).toBe("child1");
    // Rows come back in ascending index order.
    expect(runtime.calls.addObject.map((dto) => dto.id)).toEqual(["grp", "child1", "child2"]);
  });

  it("rejects an unknown id", () => {
    expect(() => editor.removeObject("ghost")).toThrow(/Unknown object id/);
  });

  it("drops a removed object from the selection", () => {
    editor.select(["child1"]);
    editor.removeObject("grp");

    expect(editor.selectedIds).toEqual([]);
  });
});

describe("reparent", () => {
  beforeEach(async () => {
    await editor.loadDocument(
      sceneDocument({
        objects: [
          sceneObject({ id: "grp", type: "group" }),
          sceneObject({ id: "child", type: "primitive", geometry: { kind: "box" }, parentId: "grp" }),
          sceneObject({ id: "box", type: "primitive", geometry: { kind: "box" } }),
        ],
      }),
    );
  });

  it("writes the new parent and undoes back to the root", () => {
    editor.reparent("box", "grp");

    expect(findBy("box")?.parentId).toBe("grp");
    expect(runtime.calls.reparent).toEqual([{ id: "box", parentId: "grp" }]);

    editor.undo();
    expect(findBy("box")?.parentId).toBeUndefined();
    expect(runtime.calls.reparent.at(-1)).toEqual({ id: "box", parentId: undefined });
  });

  it("rejects a cycle", () => {
    expect(() => editor.reparent("grp", "child")).toThrow(/cycle/i);
    expect(findBy("grp")?.parentId).toBeUndefined();
  });

  it("rejects self-parenting and unknown parents", () => {
    expect(() => editor.reparent("grp", "grp")).toThrow(/own parentId/);
    expect(() => editor.reparent("box", "ghost")).toThrow(/missing parentId/);
  });
});

describe("setMaterial", () => {
  it("persists the override and clears it on undo", () => {
    editor.setMaterial("box", { color: "#ff0000", metalness: 0.5 });

    expect(findBy("box")?.material).toEqual({ color: "#ff0000", metalness: 0.5 });
    expect(runtime.calls.setMaterial.at(-1)).toEqual({
      id: "box",
      material: { color: "#ff0000", metalness: 0.5 },
    });

    editor.undo();
    expect(findBy("box")?.material).toBeUndefined();
    expect(runtime.calls.setMaterial.at(-1)).toEqual({ id: "box", material: undefined });
  });

  it("restores the value that was current when the edit started", () => {
    editor.setMaterial("box", { color: "#ff0000" });

    // Any other command closes the merge window.
    const box = findBy("box")!;
    editor.applyTransform(
      "box",
      { position: box.position, rotation: box.rotation, scale: box.scale },
      { position: [1, 0, 0], rotation: box.rotation, scale: box.scale },
    );

    editor.setMaterial("box", { color: "#00ff00" });
    editor.undo();

    expect(findBy("box")?.material).toEqual({ color: "#ff0000" });
  });

  it("collapses consecutive writes to one object into a single undo step", () => {
    editor.setMaterial("box", { color: "#ff0000" });
    editor.setMaterial("box", { color: "#00ff00" });
    editor.setMaterial("box", { color: "#0000ff" });

    expect(findBy("box")?.material).toEqual({ color: "#0000ff" });

    // One undo covers the whole gesture: back to "no override", not #00ff00.
    editor.undo();
    expect(findBy("box")?.material).toBeUndefined();
    expect(editor.canUndo).toBe(false);
  });

  it("does not merge writes to different objects", async () => {
    await editor.loadDocument(
      sceneDocument({ objects: [sceneObject({ id: "a" }), sceneObject({ id: "b" })] }),
    );

    editor.setMaterial("a", { color: "#ff0000" });
    editor.setMaterial("b", { color: "#00ff00" });

    editor.undo();
    expect(findBy("b")?.material).toBeUndefined();
    expect(findBy("a")?.material).toEqual({ color: "#ff0000" });
  });

  it("validates values through the schema", () => {
    expect(() => editor.setMaterial("box", { roughness: 5 })).toThrow();
    expect(() => editor.setMaterial("box", { color: "red" } as never)).toThrow();
  });

  it("rejects a material on a group", async () => {
    await editor.loadDocument(
      sceneDocument({ objects: [sceneObject({ id: "grp", type: "group" })] }),
    );
    expect(() => editor.setMaterial("grp", { color: "#ff0000" })).toThrow(/cannot carry a material/);
  });

  it("marks the document dirty", () => {
    expect(editor.dirty).toBe(false);
    editor.setMaterial("box", { color: "#ff0000" });
    expect(editor.dirty).toBe(true);
  });
});
