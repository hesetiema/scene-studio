import { describe, expect, it } from "vitest";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { createConflictError } from "../../src/core/events/conflict";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

const base: SceneDocument = {
  schemaVersion: SCHEMA_VERSION,
  view: createDefaultViewState(),
  sceneId: "s1",
  revision: 3,
  objects: [],
};
const incoming: SceneDocument = { ...base, revision: 4 };
const local: SceneDocument = {
  ...base,
  objects: [
    {
      id: "x",
      type: "mesh",
      name: "x",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

describe("createConflictError (D17)", () => {
  it("builds a structured conflict SceneEditorError with base/incoming/local", () => {
    const err = createConflictError({ base, incoming, local });
    expect(err).toBeInstanceOf(SceneEditorError);
    expect(err.code).toBe(SceneErrorCode.Conflict);
    expect(err.detail).toMatchObject({ base, incoming, local });
  });
});

describe("EditorController revision + save flow", () => {
  it("exposes revision from loaded document and bumps on save", async () => {
    const controller = new EditorController(new FakeRuntime());
    await controller.loadDocument(base);
    expect(controller.revision).toBe(3);
    // host save success → markSaved bumps revision to server-acknowledged value
    controller.markSaved(4);
    expect(controller.revision).toBe(4);
    expect(controller.dirty).toBe(false);
  });

  it("applyRemote throws structured conflict when incoming revision matches neither base nor current", async () => {
    const controller = new EditorController(new FakeRuntime());
    await controller.loadDocument(base);
    // remote arrives at rev 5 while local base is 3 — not a clean fast-forward
    const remote: SceneDocument = { ...base, revision: 5 };
    try {
      controller.applyRemote(remote, { baseRevision: 3 });
      expect.unreachable("should have thrown conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Conflict);
      const detail = (err as SceneEditorError).detail as {
        base: SceneDocument;
        incoming: SceneDocument;
        local: SceneDocument;
      };
      expect(detail.incoming.revision).toBe(5);
      expect(detail.base.revision).toBe(3);
      expect(detail.local).toBeDefined();
    }
  });

  it("applyRemote fast-forwards cleanly when incoming revision is exactly base+1 (no local edits)", async () => {
    const controller = new EditorController(new FakeRuntime());
    await controller.loadDocument(base);
    const remote: SceneDocument = {
      ...base,
      revision: 4,
      objects: [
        {
          id: "remote-obj",
          type: "mesh",
          name: "r",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    };
    await controller.applyRemote(remote, { baseRevision: 3 });
    expect(controller.revision).toBe(4);
    expect(controller.getDocument().objects[0]?.id).toBe("remote-obj");
    expect(controller.dirty).toBe(false);
  });

  it("applyRemote with dirty local always conflicts (host must resolve)", async () => {
    const controller = new EditorController(new FakeRuntime());
    await controller.loadDocument(local);
    controller.applyTransform(
      "x",
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    );
    const remote: SceneDocument = { ...local, revision: 4 };
    expect(() => controller.applyRemote(remote, { baseRevision: 3 })).toThrow(
      SceneEditorError,
    );
    try {
      controller.applyRemote(remote, { baseRevision: 3 });
    } catch (err) {
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Conflict);
    }
  });
});
