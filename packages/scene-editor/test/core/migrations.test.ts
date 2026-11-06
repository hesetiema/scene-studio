import { describe, expect, it } from "vitest";
import { migrateSceneDocument, migrations } from "../../src/core/document/migrations";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION } from "../../src/core/document/schema";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const v1 = { schemaVersion: 1, sceneId: "s", revision: 3, objects: [] };

describe("migrateSceneDocument", () => {
  it("materialises view defaults for a v1 document and bumps the version", () => {
    const { document, applied } = migrateSceneDocument(v1);
    expect(applied).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
    expect(document).toEqual({
      ...v1,
      schemaVersion: SCHEMA_VERSION,
      view: createDefaultViewState(),
    });
  });

  it("upgrades v2 to v3 without reshaping anything", () => {
    const v2 = { ...v1, schemaVersion: 2, view: createDefaultViewState() };
    const { document, applied } = migrateSceneDocument(v2);
    expect(applied).toEqual([{ from: 2, to: 3 }]);
    // v3 only added optional fields, so the payload is identical apart from the stamp.
    expect(document).toEqual({ ...v2, schemaVersion: 3 });
  });

  it("leaves an existing view untouched when upgrading", () => {
    const view = createDefaultViewState();
    view.camera.fov = 35;
    const { document } = migrateSceneDocument({ ...v1, view });
    expect((document as { view: typeof view }).view).toEqual(view);
  });

  it("does not mutate its argument", () => {
    const input = { schemaVersion: 1, sceneId: "s", revision: 0, objects: [] };
    migrateSceneDocument(input);
    expect(input).toEqual({ schemaVersion: 1, sceneId: "s", revision: 0, objects: [] });
  });

  it("is idempotent for the current version", () => {
    const current = { ...v1, schemaVersion: SCHEMA_VERSION, view: createDefaultViewState() };
    const { document, applied } = migrateSceneDocument(current);
    expect(applied).toEqual([]);
    expect(document).toEqual(current);
  });

  it("rejects a missing or non-integer schemaVersion", () => {
    for (const bad of [{}, { schemaVersion: "1" }, { schemaVersion: 1.5 }, null, []]) {
      try {
        migrateSceneDocument(bad);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
        expect((err as SceneEditorError).detail).toMatchObject({
          reason: "invalid-schema-version",
        });
      }
    }
  });

  it("rejects a version below the first supported one", () => {
    try {
      migrateSceneDocument({ ...v1, schemaVersion: 0 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).detail).toMatchObject({ reason: "invalid-schema-version" });
    }
  });

  it("rejects a document from the future", () => {
    try {
      migrateSceneDocument({ ...v1, schemaVersion: 99 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).detail).toMatchObject({
        reason: "unsupported-schema-version",
        found: 99,
        supported: [1, SCHEMA_VERSION],
      });
    }
  });

  it("keeps the registry contiguous up to SCHEMA_VERSION", () => {
    // Fails when SCHEMA_VERSION is bumped without adding a migration step —
    // the same condition the missing-migration guard reports at runtime.
    let version = 1;
    while (version < SCHEMA_VERSION) {
      const step = migrations.find((m) => m.from === version);
      expect(step, `missing migration from schemaVersion ${version}`).toBeDefined();
      version = step!.to;
    }
    expect(version).toBe(SCHEMA_VERSION);
  });
});
