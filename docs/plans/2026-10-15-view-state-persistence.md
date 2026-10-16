# View State Persistence (D22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist camera, lights and environment into `SceneDocument` (schema v2), with a generic migration registry that upgrades v1 documents transparently.

**Architecture:** `view` becomes a required, fully-explicit section of the document. The document schema version becomes a literal (`2`); a migration registry in `core/document/migrations.ts` walks any older document up to the current version. The runtime gains a symmetric `getViewState()` / `applyViewState()` pair on `RuntimeContract`; interaction-driven view changes raise `view-change` (never during `applyViewState`). `CommandHistory` gains a non-command dirty flag so a view change marks the document dirty without entering the undo stack. The documented view is applied only when the loaded document's `sceneId` differs from the current one.

**Tech Stack:** TypeScript 5.9 (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), zod 4, three 0.186, vitest 5, Playwright, pnpm workspaces. Spec: `docs/specs/2026-10-15-view-state-persistence-design.md`.

---

## File Structure

**Create**
- `packages/scene-editor/src/core/document/default-view.ts` — canonical default `ViewState` (single source of truth for engine defaults; used by migration and tests).
- `packages/scene-editor/src/core/document/migrations.ts` — `Migration` type, `migrations` registry, `migrateSceneDocument()`.
- `packages/scene-editor/test/core/migrations.test.ts`
- `packages/scene-editor/test/runtime/controller-view.test.ts`
- `packages/scene-editor/test/three/three-runtime-view.test.ts`
- `packages/scene-editor/test/support/documents.ts` — shared v2 fixture factory for the whole test suite.
- `e2e/view-persistence.spec.ts`

**Modify**
- `packages/scene-editor/src/core/document/schema.ts` — `SCHEMA_VERSION`, `Vec3Schema`, `HexColorSchema`, `ViewStateSchema`, `ViewState`, literal `schemaVersion`, required `view`.
- `packages/scene-editor/src/core/document/parse.ts` — migrate → `onMigrate` → strict parse → hierarchy.
- `packages/scene-editor/src/core/history/command-history.ts` — `markDirty()` + external dirty flag.
- `packages/scene-editor/src/runtime/runtime-contract.ts` — `getViewState` / `applyViewState` / `view-change`.
- `packages/scene-editor/src/runtime/fake-runtime.ts` — implement the new contract + call recording.
- `packages/scene-editor/src/three/three-runtime.ts` — light/grid/background fields, `getViewState`, `applyViewState`, orbit `end` → `view-change`.
- `packages/scene-editor/src/runtime/editor-controller.ts` — `setViewState`, `getViewState`, `handleRuntimeViewChange`, sceneId-gated apply.
- `packages/scene-editor/src/runtime/create-scene-editor.ts` — `view-change` facade event (with `source`), `getViewState` / `setViewState`.
- `packages/scene-editor/src/element/scene-editor-element.ts` — bridge `view-change` CustomEvent.
- `packages/scene-editor/test/**` — fixtures to v2 (list in Task 4).
- `apps/playground/src/perf-bench.ts`, `apps/playground/src/webgpu-probe.ts` — v2 fixtures.
- `scripts/pack-smoke.mjs` — v2 assertions.
- `packages/scene-editor/README.md`, `packages/scene-editor/API.md` — documented `view` + `schemaVersion: 2`.
- `packages/scene-editor/package.json` + `src/bootstrap-version.ts` — 0.3.0.

---

## Task 1: Non-command dirty flag in `CommandHistory`

**Files:**
- Modify: `packages/scene-editor/src/core/history/command-history.ts`
- Test: `packages/scene-editor/test/core/command-history.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `packages/scene-editor/test/core/command-history.test.ts`:

```ts
import { CommandHistory } from "../../src/core/history/command-history";

describe("CommandHistory view dirty (D22)", () => {
  it("markDirty raises dirty without touching the undo stack", () => {
    const history = new CommandHistory();
    expect(history.dirty).toBe(false);
    history.markDirty();
    expect(history.dirty).toBe(true);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it("markClean and clear both reset the external dirty flag", () => {
    const history = new CommandHistory();
    history.markDirty();
    history.markClean();
    expect(history.dirty).toBe(false);

    history.markDirty();
    history.clear();
    expect(history.dirty).toBe(false);
  });

  it("a view dirty flag survives undo/redo bookkeeping", () => {
    const history = new CommandHistory();
    history.markDirty();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
    expect(history.dirty).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/command-history.test.ts`
Expected: FAIL — `history.markDirty is not a function`.

- [ ] **Step 3: Implement** — in `command-history.ts`, add the field, getter change, and method:

```ts
  /** Depth of undoStack at the last clean point (save/load). */
  #cleanIndex = 0;
  /** True when state changed outside the command stack (e.g. camera, D22). */
  #externalDirty = false;
  #lastCommand: string | undefined;

  get dirty(): boolean {
    return this.#externalDirty || this.#undoStack.length !== this.#cleanIndex;
  }

  /** Mark dirty from a non-command change (camera/lights/environment, D22). */
  markDirty(): void {
    if (this.#externalDirty) return;
    this.#externalDirty = true;
    this.#notify();
  }
```

Then inside `markClean()` and `clear()`, add `this.#externalDirty = false;` as the first statement of each body.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/command-history.test.ts`
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add packages/scene-editor/src/core/history/command-history.ts packages/scene-editor/test/core/command-history.test.ts
git commit -m "feat(history): add non-command dirty flag for view state (D22)"
```

---

## Task 2: Schema v2 — `view` section + literal version

**Files:**
- Create: `packages/scene-editor/src/core/document/default-view.ts`
- Modify: `packages/scene-editor/src/core/document/schema.ts`
- Test: `packages/scene-editor/test/core/document-schema.test.ts`

- [ ] **Step 1: Write the failing test** — replace the `validDoc` const and add cases in `test/core/document-schema.test.ts`:

```ts
import { SCHEMA_VERSION, ViewStateSchema } from "../../src/core/document/schema";
import { createDefaultViewState } from "../../src/core/document/default-view";

const validDoc = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "scene-1",
  revision: 0,
  objects: [validObject],
  view: createDefaultViewState(),
};

describe("ViewStateSchema", () => {
  it("accepts the engine defaults", () => {
    expect(ViewStateSchema.safeParse(createDefaultViewState()).success).toBe(true);
  });

  it("accepts a pixel-identical-looking custom view", () => {
    const view = {
      camera: { position: [-2, 8, 3], target: [1, 0, -1], fov: 45 },
      lights: {
        ambient: { color: "#ff00aa", intensity: 0.2 },
        directional: { color: "#00ff00", intensity: 2, position: [0, 5, 0] },
      },
      environment: { background: "#101010", gridVisible: false },
    };
    expect(ViewStateSchema.safeParse(view).success).toBe(true);
  });

  it("requires #rrggbb colours", () => {
    const bad = { ...createDefaultViewState() };
    bad.lights.ambient.color = "white";
    expect(ViewStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-positive fov and negative intensity", () => {
    const zeroFov = createDefaultViewState();
    zeroFov.camera.fov = 0;
    expect(ViewStateSchema.safeParse(zeroFov).success).toBe(false);

    const negative = createDefaultViewState();
    negative.lights.ambient.intensity = -1;
    expect(ViewStateSchema.safeParse(negative).success).toBe(false);
  });
});
```

And inside `describe("SceneDocumentSchema", ...)`:

```ts
  it("requires the view section (v2 is fully explicit)", () => {
    const { view: _view, ...withoutView } = validDoc;
    expect(SceneDocumentSchema.safeParse(withoutView).success).toBe(false);
  });

  it("rejects the previous schema version literal", () => {
    expect(SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: 1 }).success).toBe(false);
  });
```

Update the existing `requires schemaVersion, sceneId and revision` case to `SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: undefined })` (unchanged, still false).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/document-schema.test.ts`
Expected: FAIL — cannot resolve `../../src/core/document/default-view`.

- [ ] **Step 3: Create `default-view.ts`**

```ts
import type { ViewState } from "./schema";

/** Engine defaults (three-runtime initial state) — the canonical view of a new scene. */
export function createDefaultViewState(): ViewState {
  return {
    camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.55 },
      directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
    },
    environment: { background: null, gridVisible: true },
  };
}
```

Note: this imports the `ViewState` *type* from `schema.ts` while `schema.ts` exports only types/values — no runtime cycle because it is a type-only import.

- [ ] **Step 4: Implement schema.ts**

```ts
import { z } from "zod";

/** Current on-disk document format. Bump together with a migration (D7/D22). */
export const SCHEMA_VERSION = 2;

/** Euler XYZ rotation in radians, stored as [x, y, z] (D3). */
export type EulerXYZ = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Lower-case or upper-case hex, no alpha channel, no named colours (D22). */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const ViewStateSchema = z.strictObject({
  camera: z.strictObject({
    position: Vec3Schema,
    target: Vec3Schema,
    fov: z.number().positive(),
  }),
  lights: z.strictObject({
    ambient: z.strictObject({
      color: HexColorSchema,
      intensity: z.number().nonnegative(),
    }),
    directional: z.strictObject({
      color: HexColorSchema,
      intensity: z.number().nonnegative(),
      position: Vec3Schema,
    }),
  }),
  environment: z.strictObject({
    /** null = transparent background (preserves the pre-D22 look). */
    background: HexColorSchema.nullable(),
    gridVisible: z.boolean(),
  }),
});

export const SceneObjectSchema = // unchanged
export const SceneDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sceneId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objects: z.array(SceneObjectSchema),
  view: ViewStateSchema,
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type SceneObjectDTO = z.infer<typeof SceneObjectSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/document-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/scene-editor/src/core/document/default-view.ts packages/scene-editor/src/core/document/schema.ts packages/scene-editor/test/core/document-schema.test.ts
git commit -m "feat(document): add required view section, schema v2 (D22)"
```

---

## Task 3: Migration registry + `parseSceneDocument` wiring

**Files:**
- Create: `packages/scene-editor/src/core/document/migrations.ts`
- Modify: `packages/scene-editor/src/core/document/parse.ts`
- Test: `packages/scene-editor/test/core/migrations.test.ts`, `packages/scene-editor/test/core/parse.test.ts`

- [ ] **Step 1: Write `test/core/migrations.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { migrateSceneDocument } from "../../src/core/document/migrations";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const v1 = { schemaVersion: 1, sceneId: "s", revision: 3, objects: [] };

describe("migrateSceneDocument", () => {
  it("materialises view defaults for a v1 document and bumps the version", () => {
    const { document, applied } = migrateSceneDocument(v1);
    expect(applied).toEqual([{ from: 1, to: 2 }]);
    expect(document).toEqual({ ...v1, schemaVersion: 2, view: createDefaultViewState() });
  });

  it("leaves an existing view untouched when upgrading", () => {
    const view = createDefaultViewState();
    view.camera.fov = 35;
    const { document } = migrateSceneDocument({ ...v1, view });
    expect((document as { view: typeof view }).view).toEqual(view);
  });

  it("is idempotent for the current version", () => {
    const v2 = { ...v1, schemaVersion: 2, view: createDefaultViewState() };
    const { document, applied } = migrateSceneDocument(v2);
    expect(applied).toEqual([]);
    expect(document).toEqual(v2);
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

  it("rejects a document from the future", () => {
    try {
      migrateSceneDocument({ ...v1, schemaVersion: 99 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).detail).toMatchObject({
        reason: "unsupported-schema-version",
        found: 99,
        supported: [1, 2],
      });
    }
  });

  it("reports a missing migration step", () => {
    try {
      migrateSceneDocument({ ...v1, schemaVersion: 0 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).detail).toMatchObject({ reason: "invalid-schema-version" });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/migrations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `migrations.ts`**

```ts
import { SCHEMA_VERSION } from "./schema";
import { createDefaultViewState } from "./default-view";
import { SceneEditorError, SceneErrorCode } from "../events/errors";

type RawDocument = Record<string, unknown>;

export interface Migration {
  readonly from: number;
  readonly to: number;
  /** Receives a pre-validation object; must not mutate its argument. */
  migrate(doc: RawDocument): RawDocument;
}

function v1ToV2(doc: RawDocument): RawDocument {
  const next: RawDocument = { ...doc };
  if (next.view === undefined) next.view = createDefaultViewState();
  next.schemaVersion = 2;
  return next;
}

/** Append-only; each entry must advance exactly one version (D7/D22). */
export const migrations: readonly Migration[] = [{ from: 1, to: 2, migrate: v1ToV2 }];

export interface MigrationReport {
  from: number;
  to: number;
}

export interface MigrationResult {
  document: unknown;
  applied: MigrationReport[];
}

function migrationError(
  reason: string,
  message: string,
  detail: Record<string, unknown>,
): SceneEditorError {
  return new SceneEditorError(SceneErrorCode.Validation, message, {
    detail: { reason, ...detail },
  });
}

/** Walk any older document up to SCHEMA_VERSION; throws a Validation error if impossible. */
export function migrateSceneDocument(input: unknown): MigrationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw migrationError("invalid-schema-version", "SceneDocument must be an object", {
      found: input,
    });
  }
  const raw = input as RawDocument;
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw migrationError("invalid-schema-version", "Invalid schemaVersion", { found: version });
  }
  if (version > SCHEMA_VERSION) {
    throw migrationError(
      "unsupported-schema-version",
      `Unsupported schemaVersion ${version}`,
      { found: version, supported: [1, SCHEMA_VERSION] },
    );
  }

  let document: RawDocument = raw;
  let current = version;
  const applied: MigrationReport[] = [];
  while (current < SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === current);
    if (!step) {
      throw migrationError("missing-migration", `No migration from schemaVersion ${current}`, {
        from: current,
      });
    }
    document = step.migrate(document);
    current = step.to;
    applied.push({ from: step.from, to: step.to });
  }
  return { document, applied };
}
```

- [ ] **Step 4: Wire `parse.ts`**

```ts
import { SceneDocumentSchema, type SceneDocument } from "./schema";
import { migrateSceneDocument, type MigrationReport } from "./migrations";
import { validateHierarchy } from "./hierarchy";
import { SceneEditorError, SceneErrorCode } from "../events/errors";

export interface ParseSceneDocumentOptions {
  /** Called once per applied migration step, oldest first. */
  onMigrate?: (report: MigrationReport) => void;
}

export function parseSceneDocument(
  input: unknown,
  options: ParseSceneDocumentOptions = {},
): SceneDocument {
  const { document, applied } = migrateSceneDocument(input);
  for (const report of applied) options.onMigrate?.(report);
  const result = SceneDocumentSchema.safeParse(document);
  if (!result.success) {
    throw new SceneEditorError(SceneErrorCode.Validation, "Invalid SceneDocument", {
      cause: result.error,
      detail: { issues: result.error.issues },
    });
  }
  validateHierarchy(result.data.objects);
  return result.data;
}
```

- [ ] **Step 5: Update `test/core/parse.test.ts`** to v2 + migration coverage:

```ts
import { describe, expect, it, vi } from "vitest";
import { parseSceneDocument } from "../../src/core/document/parse";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION } from "../../src/core/document/schema";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const v1Doc = { schemaVersion: 1, sceneId: "scene-1", revision: 0, objects: [] };
const v2Doc = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "scene-1",
  revision: 0,
  objects: [],
  view: createDefaultViewState(),
};

describe("parseSceneDocument", () => {
  it("returns the parsed document on success", () => {
    expect(parseSceneDocument(v2Doc)).toEqual(v2Doc);
  });

  it("migrates a v1 document and reports the step", () => {
    const onMigrate = vi.fn();
    expect(parseSceneDocument(v1Doc, { onMigrate })).toEqual({
      ...v1Doc,
      schemaVersion: 2,
      view: createDefaultViewState(),
    });
    expect(onMigrate).toHaveBeenCalledWith({ from: 1, to: 2 });
  });

  it("does not report a migration for a current document", () => {
    const onMigrate = vi.fn();
    parseSceneDocument(v2Doc, { onMigrate });
    expect(onMigrate).not.toHaveBeenCalled();
  });

  it("throws SceneEditorError with validation code on invalid input", () => {
    try {
      parseSceneDocument({ ...v2Doc, revision: -5 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneEditorError);
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).detail).toMatchObject({
        issues: expect.any(Array),
      });
    }
  });

  it("surfaces migration errors as validation errors with a reason", () => {
    try {
      parseSceneDocument({ schemaVersion: 99 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SceneEditorError).code).toBe(SceneErrorCode.Validation);
      expect((err as SceneEditorError).detail).toMatchObject({
        reason: "unsupported-schema-version",
      });
    }
  });
});
```

- [ ] **Step 6: Run**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/core/migrations.test.ts test/core/parse.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/scene-editor/src/core/document/migrations.ts packages/scene-editor/src/core/document/parse.ts packages/scene-editor/test/core/migrations.test.ts packages/scene-editor/test/core/parse.test.ts
git commit -m "feat(document): generic migration registry, v1 to v2 view upgrade (D7/D22)"
```

---

## Task 4: Fixture migration across the test suite and apps

**Files:**
- Create: `packages/scene-editor/test/support/documents.ts`
- Modify (test fixtures): `test/element/viewport-interaction.test.ts:11`, `test/element/scene-editor-element.test.ts:12,274`, `test/element/perf-marks.test.ts:13`, `test/three/three-runtime.test.ts:26,179`, `test/three/runtime-assets.test.ts:33`, `test/core/conflict.test.ts:9`, `test/runtime/controller-document.test.ts:9`, `test/runtime/controller-commands.test.ts:9`, `test/runtime/editor-controller.test.ts:8`, `test/runtime/create-scene-editor.test.ts:9,58`
- Modify (apps): `apps/playground/src/perf-bench.ts:189`, `apps/playground/src/webgpu-probe.ts:257`
- Modify: `scripts/pack-smoke.mjs:96,97,135`

Deliberately **left at v1** (they exercise the migration in real apps): `apps/playground/src/main.ts:29`, `apps/ssr-demo/index.html:126`.

- [ ] **Step 1: Create the fixture factory** `test/support/documents.ts`:

```ts
import { createDefaultViewState } from "../../src/core/document/default-view";
import { SCHEMA_VERSION, type SceneDocument } from "../../src/core/document/schema";

/** Current-version document for tests. Prefer this over inline literals. */
export function sceneDocument(overrides: Partial<SceneDocument> = {}): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: "scene-1",
    revision: 0,
    objects: [],
    view: createDefaultViewState(),
    ...overrides,
  };
}

/** Historical v1 document — only for migration tests. */
export function v1SceneDocument() {
  return { schemaVersion: 1, sceneId: "scene-1", revision: 0, objects: [] };
}
```

- [ ] **Step 2: Apply the migration per file.** Replace each inline `const doc: SceneDocument = { schemaVersion: 1, ... }` with either an import of `sceneDocument`/`v1SceneDocument` from the support module, or an inline literal plus `view: createDefaultViewState()`. Two mechanical rules:

1. Any fixture annotated `: SceneDocument` (or passed where a v2 document is compared with `toEqual`) → `sceneDocument({ ... })`.
2. Any fixture whose only purpose is to reach `loadDocument`'s happy path → `sceneDocument()`.

`test/element/scene-editor-element.test.ts:274` and `test/runtime/create-scene-editor.test.ts:58` assert that `{ schemaVersion: 1 }` rejects — keep them as-is (they still reject: missing `view` *and* wrong version literal).

- [ ] **Step 3: Update `scripts/pack-smoke.mjs`** (the three assertions at 96/97/135) to:

```js
`assert.equal(typeof SceneDocumentSchema.parse({ schemaVersion: 2, sceneId: "t", revision: 0, objects: [], view: ${JSON.stringify(createDefaultViewStateForSmoke())} }).sceneId, "string");`,
`assert.throws(() => SceneDocumentSchema.parse({ schemaVersion: 1 }));`,
`const doc = SceneDocumentSchema.parse({ ... }) satisfies SceneDocument;`,
```

where the v2 object literal is inlined with the default view values (position `[6,5,10]`, target `[0,0,0]`, fov `60`, ambient `#ffffff`/`0.55`, directional `#ffffff`/`1`/`[5,10,7]`, background `null`, gridVisible `true`).

- [ ] **Step 4: Update app fixtures** — in `perf-bench.ts` and `webgpu-probe.ts` change `schemaVersion: 1` → `schemaVersion: 2` and add a `view` object with the default values above.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm typecheck && pnpm --filter @scenio/scene-editor test`
Expected: PASS (140+ tests). Any remaining failure is an assertion that encoded the old shape — fix the assertion, never loosen the schema.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: migrate fixtures to document schema v2 (D22)"
```

---

## Task 5: `RuntimeContract` view API + `FakeRuntime`

**Files:**
- Modify: `packages/scene-editor/src/runtime/runtime-contract.ts`, `packages/scene-editor/src/runtime/fake-runtime.ts`
- Test: `packages/scene-editor/test/runtime/fake-runtime-view.test.ts` (create)

- [ ] **Step 1: Write the failing test**:

```ts
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";

describe("FakeRuntime view contract (D22)", () => {
  it("records applied views and returns the last one", () => {
    const runtime = new FakeRuntime();
    const view = createDefaultViewState();
    view.camera.fov = 42;
    runtime.applyViewState(view);
    expect(runtime.calls.applyViewState).toEqual([view]);
    expect(runtime.getViewState()).toEqual(view);
  });

  it("reports the default view before anything is applied", () => {
    expect(new FakeRuntime().getViewState()).toEqual(createDefaultViewState());
  });

  it("emits view-change through the bus when a helper simulates interaction", () => {
    const runtime = new FakeRuntime();
    const seen: unknown[] = [];
    runtime.events.on("view-change", (payload) => seen.push(payload));
    const view = createDefaultViewState();
    view.camera.position = [1, 2, 3];
    runtime.simulateViewChange(view);
    expect(seen).toEqual([{ view }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime/fake-runtime-view.test.ts`
Expected: FAIL — `applyViewState` is not a function.

- [ ] **Step 3: Extend `runtime-contract.ts`**

```ts
import type { SceneDocument, ViewState } from "../core/document/schema";

export type RuntimeEventMap = {
  // …existing entries unchanged…
  /** Interaction-driven viewport change (never emitted by applyViewState). */
  "view-change": { view: ViewState };
  error: { code: string; message: string; cause?: unknown };
};

export interface RuntimeContract {
  loadDocument(doc: SceneDocument): Promise<void>;
  applyTransform(id: string, t: Transform): void;
  clearSelection(): void;
  select(ids: string[]): void;
  pick(clientX: number, clientY: number): string | null;
  flushDisposers(): void;
  /** Current camera/lights/environment as a persistable snapshot (D22). */
  getViewState(): ViewState;
  /** Apply a persisted view without raising view-change (D22). */
  applyViewState(view: ViewState): void;
  readonly events: RuntimeEventBus;
}
```

- [ ] **Step 4: Extend `fake-runtime.ts`**

```ts
  readonly calls = {
    // …existing…
    applyViewState: [] as ViewState[],
  };
  #view: ViewState = createDefaultViewState();
  viewChangeOnApply = false;

  getViewState(): ViewState {
    return structuredClone(this.#view);
  }

  applyViewState(view: ViewState): void {
    this.calls.applyViewState.push(structuredClone(view));
    this.#view = structuredClone(view);
    if (this.viewChangeOnApply) this.events.emit("view-change", { view: this.getViewState() });
  }

  /** Test helper: pretend the user moved the camera. */
  simulateViewChange(view: ViewState): void {
    this.#view = structuredClone(view);
    this.events.emit("view-change", { view: this.getViewState() });
  }
```

with `import { createDefaultViewState } from "../core/document/default-view";` and `ViewState` added to the type import.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime/fake-runtime-view.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/scene-editor/src/runtime/runtime-contract.ts packages/scene-editor/src/runtime/fake-runtime.ts packages/scene-editor/test/runtime/fake-runtime-view.test.ts
git commit -m "feat(runtime): add getViewState/applyViewState/view-change to the contract (D22)"
```

---

## Task 6: `ThreeRuntime` view read/write + interaction event

**Files:**
- Modify: `packages/scene-editor/src/three/three-runtime.ts`
- Test: `packages/scene-editor/test/three/three-runtime-view.test.ts` (create)

- [ ] **Step 1: Write the failing test** (no WebGL: inject the renderer + orbit seams, `enableControls: false` for the pure round-trip cases):

```ts
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ThreeRuntime } from "../../src/three/three-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";

function makeRenderer() {
  return {
    domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("ThreeRuntime view state (D22)", () => {
  it("reports the engine defaults as the initial view", () => {
    const runtime = new ThreeRuntime({
      canvas: {} as HTMLCanvasElement,
      rendererFactory: makeRenderer as never,
      enableControls: false,
    });
    expect(runtime.getViewState()).toEqual(createDefaultViewState());
  });

  it("round-trips an applied view", () => {
    const runtime = new ThreeRuntime({
      canvas: {} as HTMLCanvasElement,
      rendererFactory: makeRenderer as never,
      enableControls: false,
    });
    const view = createDefaultViewState();
    view.camera = { position: [-4, 3, 2], target: [1, 1, 0], fov: 30 };
    view.lights.ambient = { color: "#123456", intensity: 0.9 };
    view.lights.directional = { color: "#654321", intensity: 0.4, position: [1, 2, 3] };
    view.environment = { background: "#0f0f0f", gridVisible: false };

    runtime.applyViewState(view);
    expect(runtime.getViewState()).toEqual(view);
  });

  it("does not emit view-change while applying a view", () => {
    const runtime = new ThreeRuntime({
      canvas: {} as HTMLCanvasElement,
      rendererFactory: makeRenderer as never,
      enableControls: false,
    });
    const seen: unknown[] = [];
    runtime.events.on("view-change", (p) => seen.push(p));
    runtime.applyViewState(createDefaultViewState());
    expect(seen).toEqual([]);
  });

  it("emits view-change exactly once per orbit interaction end", () => {
    const listeners = new Map<string, () => void>();
    const orbit = {
      update: vi.fn(),
      dispose: vi.fn(),
      target: new THREE.Vector3(),
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    };
    const runtime = new ThreeRuntime({
      canvas: {} as HTMLCanvasElement,
      rendererFactory: makeRenderer as never,
      orbitControlsFactory: () => orbit,
      transformControlsFactory: () => null as never,
    });
    const seen: Array<{ view: ReturnType<typeof createDefaultViewState> }> = [];
    runtime.events.on("view-change", (p) => seen.push(p));

    runtime.camera.position.set(1, 2, 3);
    orbit.target.set(0, 1, 0);
    listeners.get("end")?.();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.view.camera.position).toEqual([1, 2, 3]);
    expect(seen[0]?.view.camera.target).toEqual([0, 1, 0]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/three/three-runtime-view.test.ts`
Expected: FAIL — `getViewState is not a function`.

- [ ] **Step 3: Implement in `three-runtime.ts`**

Add imports: `import { createDefaultViewState } from "../core/document/default-view";` and `ViewState` to the schema type import.

Extend `ThreeRuntimeOptions.orbitControlsFactory`'s return type to:

```ts
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => {
    update: () => void;
    dispose: () => void;
    target?: THREE.Vector3;
    addEventListener?: (type: string, handler: () => void) => void;
  } | null;
```

Keep the resolved orbit in a field typed the same way. Add fields:

```ts
  readonly #ambient: THREE.AmbientLight;
  readonly #directional: THREE.DirectionalLight;
  readonly #grid: THREE.GridHelper;
  #fallbackTarget = new THREE.Vector3(0, 0, 0);
  #applyingView = false;
```

In the constructor replace the locals:

```ts
    this.#ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.#directional = new THREE.DirectionalLight(0xffffff, 1);
    this.#directional.position.set(5, 10, 7);
    this.#grid = new THREE.GridHelper(10, 10);
    this.scene.add(this.#ambient, this.#directional, this.#grid);
```

In `#initControls`, wire the interaction event for the real OrbitControls path:

```ts
          controls.addEventListener?.("change", () => this.#render());
          controls.addEventListener?.("end", () => this.#emitViewChange());
```

and for the injected factory path, after assigning `this.#orbit`:

```ts
      if (options.orbitControlsFactory) {
        const orbit = options.orbitControlsFactory(this.camera, dom);
        orbit?.addEventListener?.("end", () => this.#emitViewChange());
        this.#orbit = orbit;
      } else {
```

Add the methods:

```ts
  getViewState(): ViewState {
    const target = this.#orbit?.target ?? this.#fallbackTarget;
    return {
      camera: {
        position: [
          this.camera.position.x,
          this.camera.position.y,
          this.camera.position.z,
        ],
        target: [target.x, target.y, target.z],
        fov: this.camera.fov,
      },
      lights: {
        ambient: {
          color: toHex(this.#ambient.color),
          intensity: this.#ambient.intensity,
        },
        directional: {
          color: toHex(this.#directional.color),
          intensity: this.#directional.intensity,
          position: [
            this.#directional.position.x,
            this.#directional.position.y,
            this.#directional.position.z,
          ],
        },
      },
      environment: {
        background: this.scene.background instanceof THREE.Color
          ? toHex(this.scene.background)
          : null,
        gridVisible: this.#grid.visible,
      },
    };
  }

  applyViewState(view: ViewState): void {
    this.#applyingView = true;
    try {
      const { camera, lights, environment } = view;
      this.camera.position.set(camera.position[0], camera.position[1], camera.position[2]);
      this.camera.fov = camera.fov;
      this.camera.lookAt(camera.target[0], camera.target[1], camera.target[2]);
      this.camera.updateProjectionMatrix();
      this.#fallbackTarget.set(camera.target[0], camera.target[1], camera.target[2]);
      this.#orbit?.target?.set(camera.target[0], camera.target[1], camera.target[2]);

      this.#ambient.color.set(lights.ambient.color);
      this.#ambient.intensity = lights.ambient.intensity;
      this.#directional.color.set(lights.directional.color);
      this.#directional.intensity = lights.directional.intensity;
      this.#directional.position.set(
        lights.directional.position[0],
        lights.directional.position[1],
        lights.directional.position[2],
      );

      this.scene.background =
        environment.background === null ? null : new THREE.Color(environment.background);
      this.#grid.visible = environment.gridVisible;

      this.#render();
    } finally {
      this.#applyingView = false;
    }
  }

  #emitViewChange(): void {
    if (this.#applyingView) return;
    this.events.emit("view-change", { view: this.getViewState() });
  }
```

plus a module-level helper:

```ts
function toHex(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}
```

Note: the constructor must still set the initial camera from `createDefaultViewState()` so the hard-coded numbers live in exactly one place:

```ts
    const initial = createDefaultViewState();
    this.camera = new THREE.PerspectiveCamera(initial.camera.fov, 4 / 3, 0.1, 1000);
    this.camera.position.set(
      initial.camera.position[0], initial.camera.position[1], initial.camera.position[2],
    );
    this.camera.lookAt(0, 0, 0);
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/three`
Expected: PASS (new file + existing three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/scene-editor/src/three/three-runtime.ts packages/scene-editor/test/three/three-runtime-view.test.ts
git commit -m "feat(three): implement getViewState/applyViewState and orbit view-change (D22)"
```

---

## Task 7: `EditorController` view handling

**Files:**
- Modify: `packages/scene-editor/src/runtime/editor-controller.ts`
- Test: `packages/scene-editor/test/runtime/controller-view.test.ts` (create)

- [ ] **Step 1: Write the failing test**:

```ts
import { describe, expect, it } from "vitest";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { sceneDocument } from "../support/documents";
import { SceneEditorError } from "../../src/core/events/errors";

async function setup(doc = sceneDocument()) {
  const runtime = new FakeRuntime();
  const controller = new EditorController(runtime);
  await controller.loadDocument(doc);
  return { runtime, controller };
}

describe("EditorController view state (D22)", () => {
  it("applies the documented view when the scene changes", async () => {
    const doc = sceneDocument({ sceneId: "a", view: createDefaultViewState() });
    doc.view.camera.fov = 40;
    const { runtime } = await setup(doc);
    expect(runtime.calls.applyViewState).toHaveLength(1);
    expect(runtime.calls.applyViewState[0]?.camera.fov).toBe(40);
  });

  it("does not re-apply the view for the same scene, nor for applyRemote on the same scene", async () => {
    const { runtime, controller } = await setup(sceneDocument({ sceneId: "a", revision: 0 }));
    expect(runtime.calls.applyViewState).toHaveLength(1);

    await controller.applyRemote(
      sceneDocument({ sceneId: "a", revision: 1 }),
      { baseRevision: 0 },
    );
    expect(runtime.calls.applyViewState).toHaveLength(1);
  });

  it("applies the view when applyRemote switches scenes", async () => {
    const { runtime, controller } = await setup(sceneDocument({ sceneId: "a", revision: 0 }));
    await controller.applyRemote(
      sceneDocument({ sceneId: "b", revision: 1 }),
      { baseRevision: 0 },
    );
    expect(runtime.calls.applyViewState).toHaveLength(2);
  });

  it("marks dirty on a runtime interaction without entering the undo stack", async () => {
    const { runtime, controller } = await setup();
    expect(controller.dirty).toBe(false);
    const view = createDefaultViewState();
    view.camera.fov = 12;
    runtime.simulateViewChange(view);
    expect(controller.dirty).toBe(true);
    expect(controller.canUndo).toBe(false);
    expect(controller.getDocument().view.camera.fov).toBe(12);
  });

  it("marks dirty on setViewState and forwards it to the runtime", async () => {
    const { runtime, controller } = await setup();
    const view = createDefaultViewState();
    view.environment.gridVisible = false;
    controller.setViewState(view);
    expect(controller.dirty).toBe(true);
    expect(controller.canUndo).toBe(false);
    expect(runtime.calls.applyViewState.at(-1)).toEqual(view);
    expect(controller.getDocument().view.environment.gridVisible).toBe(false);
  });

  it("clears the view dirty flag on markSaved", async () => {
    const { runtime, controller } = await setup();
    const view = createDefaultViewState();
    view.camera.fov = 50;
    runtime.simulateViewChange(view);
    expect(controller.dirty).toBe(true);
    controller.markSaved(1);
    expect(controller.dirty).toBe(false);
  });

  it("throws a lifecycle error when setting a view with no document", () => {
    const controller = new EditorController(new FakeRuntime());
    expect(() => controller.setViewState(createDefaultViewState())).toThrow(SceneEditorError);
  });

  it("ignores a runtime view change before any document is loaded", () => {
    const controller = new EditorController(new FakeRuntime());
    expect(() => controller.handleRuntimeViewChange(createDefaultViewState())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime/controller-view.test.ts`
Expected: FAIL — `controller.setViewState is not a function`.

- [ ] **Step 3: Implement in `editor-controller.ts`**

Add `import type { SceneDocument, ViewState } from "../core/document/schema";` (extend the existing type import) and:

```ts
  /** Host/runtime view snapshot of the current viewport (D22). */
  getViewState(): ViewState {
    return this.runtime.getViewState();
  }

  /** Explicit host-driven view update: recorded in the document, marked dirty, not undoable. */
  setViewState(view: ViewState): void {
    if (!this.#doc) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "No document loaded");
    }
    this.#doc = { ...this.#doc, view: structuredClone(view) };
    this.runtime.applyViewState(view);
    this.history.markDirty();
  }

  /** Runtime reported a user interaction — record it, mark dirty (D22). */
  handleRuntimeViewChange(view: ViewState): void {
    if (!this.#doc) return;
    this.#doc = { ...this.#doc, view: structuredClone(view) };
    this.history.markDirty();
  }
```

Then gate the applied view on scene changes. In `loadDocument`:

```ts
  async loadDocument(input: unknown): Promise<void> {
    const doc = parseSceneDocument(input);
    await this.runtime.loadDocument(doc);
    const sceneChanged = this.#doc?.sceneId !== doc.sceneId;
    this.#doc = structuredClone(doc);
    this.#baseRevision = doc.revision;
    this.history.clear();
    this.selection.clear();
    if (sceneChanged) this.runtime.applyViewState(doc.view);
  }
```

In `applyRemote`, inside the `.then(...)` callback, replace the body with:

```ts
      const sceneChanged = this.#doc?.sceneId !== remote.sceneId;
      this.#doc = structuredClone(remote);
      this.#baseRevision = remote.revision;
      this.history.clear();
      this.selection.clear();
      if (sceneChanged) this.runtime.applyViewState(remote.view);
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime`
Expected: PASS (new file + existing runtime tests; Task 4 already moved fixtures to v2).

- [ ] **Step 5: Commit**

```bash
git add packages/scene-editor/src/runtime/editor-controller.ts packages/scene-editor/test/runtime/controller-view.test.ts
git commit -m "feat(controller): record view state, dirty without undo, apply on scene change (D22)"
```

---

## Task 8: Facade `view-change` event + `getViewState`/`setViewState`

**Files:**
- Modify: `packages/scene-editor/src/runtime/create-scene-editor.ts`
- Test: `packages/scene-editor/test/runtime/create-scene-editor-view.test.ts` (create)

- [ ] **Step 1: Write the failing test**:

```ts
import { describe, expect, it } from "vitest";
import { createSceneEditor } from "../../src/runtime/create-scene-editor";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";
import { sceneDocument } from "../support/documents";

async function setup() {
  const runtime = new FakeRuntime();
  const editor = createSceneEditor({ runtime });
  await editor.loadDocument(sceneDocument({ sceneId: "a" }));
  return { runtime, editor };
}

describe("facade view state (D22)", () => {
  it("forwards interaction view changes with source=interaction", async () => {
    const { runtime, editor } = await setup();
    const seen: Array<{ source: string; fov: number }> = [];
    editor.on("view-change", ({ view, source }) =>
      seen.push({ source, fov: view.camera.fov }));
    const view = createDefaultViewState();
    view.camera.fov = 21;
    runtime.simulateViewChange(view);
    expect(seen).toEqual([{ source: "interaction", fov: 21 }]);
    expect(editor.dirty).toBe(true);
  });

  it("emits source=api for an explicit setViewState", async () => {
    const { editor } = await setup();
    const sources: string[] = [];
    editor.on("view-change", ({ source }) => sources.push(source));
    const view = createDefaultViewState();
    view.camera.fov = 22;
    editor.setViewState(view);
    expect(sources).toEqual(["api"]);
    expect(editor.getDocument().view.camera.fov).toBe(22);
  });

  it("emits source=load when a new scene applies the documented view", async () => {
    const { editor } = await setup();
    const seen: Array<{ source: string; fov: number }> = [];
    editor.on("view-change", ({ view, source }) =>
      seen.push({ source, fov: view.camera.fov }));
    const next = sceneDocument({ sceneId: "b" });
    next.view.camera.fov = 33;
    await editor.loadDocument(next);
    expect(seen).toEqual([{ source: "load", fov: 33 }]);
  });

  it("does not emit source=load for the same scene", async () => {
    const { editor } = await setup();
    const sources: string[] = [];
    editor.on("view-change", ({ source }) => sources.push(source));
    await editor.loadDocument(sceneDocument({ sceneId: "a" }));
    expect(sources).toEqual([]);
  });

  it("exposes the runtime view through getViewState", async () => {
    const { runtime, editor } = await setup();
    const view = createDefaultViewState();
    view.camera.fov = 7;
    runtime.simulateViewChange(view);
    expect(editor.getViewState().camera.fov).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime/create-scene-editor-view.test.ts`
Expected: FAIL — no `view-change` listener.

- [ ] **Step 3: Implement in `create-scene-editor.ts`**

Add `ViewState` to the schema type import, then to `SceneEditorEventMap`:

```ts
  /**
   * Viewport view changed. source: "interaction" (user), "api" (host setViewState),
   * "load" (documented view applied for a new scene).
   */
  "view-change": { view: ViewState; source: "interaction" | "api" | "load" };
```

Add to the `SceneEditor` interface:

```ts
  /** Current runtime viewport view (live truth; the document is the last recorded one). */
  getViewState(): ViewState;
  /** Explicitly record + apply a view. Marks dirty without entering the undo stack. */
  setViewState(view: ViewState): void;
```

In the constructor, after the `history-change` subscription:

```ts
    this.runtime.events.on("view-change", ({ view }) => {
      this.#controller.handleRuntimeViewChange(view);
      this.#emit("view-change", { view, source: "interaction" });
    });
```

Add the implementation methods (next to `applyTransform`):

```ts
  getViewState(): ViewState {
    this.#assertLive();
    return this.#controller.getViewState();
  }

  setViewState(view: ViewState): void {
    this.#assertLive();
    this.#controller.setViewState(view);
    this.#emit("view-change", { view: this.#controller.getDocument().view, source: "api" });
  }
```

And in `loadDocument`, emit `source: "load"` only when the view was actually applied:

```ts
  async loadDocument(doc: unknown): Promise<void> {
    this.#assertLive();
    const previousSceneId = this.#controller.getSceneId();
    try {
      await this.#controller.loadDocument(doc);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
    const current = this.#controller.getDocument();
    if (current.sceneId !== previousSceneId) {
      this.#emit("view-change", { view: current.view, source: "load" });
    }
  }
```

This needs one small controller accessor — add to `EditorController`:

```ts
  /** Scene id of the loaded document, or null before the first load (D22). */
  getSceneId(): string | null {
    return this.#doc?.sceneId ?? null;
  }
```

(`previousSceneId` must be read *before* the load, which the code above does.)

- [ ] **Step 4: Run**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/runtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/scene-editor/src/runtime/create-scene-editor.ts packages/scene-editor/src/runtime/editor-controller.ts packages/scene-editor/test/runtime/create-scene-editor-view.test.ts
git commit -m "feat(facade): typed view-change with source attribution (D22)"
```

---

## Task 9: Element bridging

**Files:**
- Modify: `packages/scene-editor/src/element/scene-editor-element.ts`
- Test: `packages/scene-editor/test/element/scene-editor-element-test.ts` (append to `scene-editor-element.test.ts`)

- [ ] **Step 1: Write the failing test** — append to `test/element/scene-editor-element.test.ts` (follow the file's existing mount/FakeRuntime pattern):

```ts
  it("bridges view-change to a DOM CustomEvent", async () => {
    const runtime = new FakeRuntime();
    SceneEditorElement.runtimeFactory = () => runtime;
    const el = document.createElement("scene-editor") as SceneEditorElement;
    document.body.appendChild(el);
    await el.ready;
    await el.loadDocument(sceneDocument());

    const seen: Array<{ source: string; fov: number }> = [];
    el.addEventListener("view-change", (event) => {
      const detail = (event as CustomEvent<{ source: string; view: { camera: { fov: number } } }>)
        .detail;
      seen.push({ source: detail.source, fov: detail.view.camera.fov });
    });
    const view = createDefaultViewState();
    view.camera.fov = 19;
    runtime.simulateViewChange(view);

    expect(seen).toEqual([{ source: "interaction", fov: 19 }]);
    el.remove();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/element/scene-editor-element.test.ts`
Expected: FAIL — no `view-change` event observed.

- [ ] **Step 3: Implement** — in `#init`, alongside the other bridges:

```ts
      editor.on("view-change", (payload) => {
        this.dispatchEvent(new CustomEvent("view-change", { detail: payload }));
      });
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @scenio/scene-editor exec vitest run test/element`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/scene-editor/src/element/scene-editor-element.ts packages/scene-editor/test/element/scene-editor-element.test.ts
git commit -m "feat(element): bridge view-change CustomEvent (D22)"
```

---

## Task 10: End-to-end camera restore in a real browser

**Files:**
- Modify: `apps/playground/src/main.ts` (add a read-only test hook)
- Create: `e2e/view-persistence.spec.ts`

- [ ] **Step 1: Add the playground hook.** In `apps/playground/src/main.ts`, the element is created by `defineSceneEditor`/tag. Wrap the default runtime factory so the created runtime is reachable from tests (test-only, read-only):

```ts
import { SceneEditorElement } from "@scenio/scene-editor/element";
// existing imports...

declare global {
  interface Window {
    __savedDocs: SceneDocument[];
    /** Test-only: the runtime behind the live element. */
    __runtime?: { getViewState(): unknown; camera?: { position: { x: number; y: number; z: number } } };
  }
}

const baseFactory = SceneEditorElement.runtimeFactory;
SceneEditorElement.runtimeFactory = (canvas, options) => {
  const runtime = baseFactory(canvas, options);
  window.__runtime = runtime as never;
  return runtime;
};
```

Place this **before** the element connects (immediately after the imports / before `document.querySelector("scene-editor")` is used).

- [ ] **Step 2: Write the failing spec** `e2e/view-persistence.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("camera view survives save and reload", async ({ page }) => {
  await page.goto("/");
  const el = page.locator("scene-editor");
  await el.evaluate((node) => (node as { ready: Promise<void> }).ready);

  // Move the camera the way a user would, through the runtime seam.
  await page.evaluate(() => {
    const runtime = window.__runtime as {
      camera?: { position: { x: number; y: number; z: number } };
      events: { emit(type: string, payload: unknown): void };
      getViewState(): unknown;
    };
    runtime.camera?.position && ((runtime.camera.position.x = 3), (runtime.camera.position.y = 9));
    // simulate the interaction end event OrbitControls would raise
    (runtime.events as unknown as { emit: (t: string, p: unknown) => void }).emit(
      "view-change",
      { view: runtime.getViewState() },
    );
  });

  await el.evaluate((node) => (node as { requestSave(): void }).requestSave());

  const savedView = await page.evaluate(() => window.__savedDocs[0]?.view);
  expect(savedView).toBeTruthy();
  expect((savedView as { camera: { fov: number } }).camera.fov).toBeGreaterThan(0);

  // Reload as a new scene and confirm the camera is restored, not re-defaulted.
  await el.evaluate((node) => {
    const doc = window.__savedDocs[0]!;
    return (node as { loadDocument(d: unknown): Promise<void> }).loadDocument({
      ...doc,
      sceneId: "scene-reloaded",
    });
  });

  const restored = await page.evaluate(() => window.__runtime?.getViewState());
  expect((restored as { camera: { position: number[] } }).camera.position).toEqual(
    (savedView as { camera: { position: number[] } }).camera.position,
  );
});
```

- [ ] **Step 3: Run to verify failure**

Run: `$env:CI=1; pnpm test:e2e --project=chromium view-persistence.spec.ts`
Expected: FAIL — the hook or the persisted `view` is missing.

- [ ] **Step 4: Make it pass.** The hook above plus Tasks 2–9 should be sufficient; if `__savedDocs[0].view` is absent, the document was saved before migration — check that `loadDocument` ran first in the spec.

- [ ] **Step 5: Run the full e2e suite (serially — never alongside perf)**

Run: `$env:CI=1; pnpm test:e2e --project=chromium critical-flows.spec.ts view-persistence.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Visual regression** (must be run **alone**, no parallel perf):

Run: `pnpm test:e2e:visual`
Expected: PASS with the 5 existing snapshots unchanged (defaults reproduce the pre-D22 render; `background: null` stays transparent).

- [ ] **Step 7: Commit**

```bash
git add apps/playground/src/main.ts e2e/view-persistence.spec.ts
git commit -m "test(e2e): camera view survives save and reload (D22)"
```

---

## Task 11: Docs, version and full verification

**Files:**
- Modify: `packages/scene-editor/README.md:32,117`, `packages/scene-editor/API.md:55`, `packages/scene-editor/package.json`, `packages/scene-editor/src/bootstrap-version.ts`

- [ ] **Step 1: Update `README.md`** — the sample document at line 32 becomes v2 with a default `view`, and the `SceneDocument` sketch at line 117 documents the new section:

```ts
  schemaVersion: 2; // positive int literal; currently 2 (v1 is migrated on load)
  view: {
    camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
    lights: {
      ambient: { color: "#rrggbb"; intensity: number };
      directional: { color: "#rrggbb"; intensity: number; position: [number, number, number] };
    };
    environment: { background: "#rrggbb" | null; gridVisible: boolean };
  };
```

Add a short prose note: v1 documents load unchanged (the migration fills the engine defaults); the documented view is applied only when the loaded document's `sceneId` changes; a camera move marks the document dirty but is not undoable; `view-change` carries `source: "interaction" | "api" | "load"`.

- [ ] **Step 2: Update `API.md`** — the `SceneDocumentSchema` row becomes: "Strict object: `schemaVersion` (literal 2), `sceneId`, `revision`, `objects[]`, `view`". Add rows for `ViewStateSchema`, `migrateSceneDocument`, `parseSceneDocument(input, { onMigrate })`, `SceneEditor.getViewState()` / `setViewState()` and the `view-change` event.

- [ ] **Step 3: Bump to 0.3.0**

Run: `pnpm --filter @scenio/scene-editor exec npm version 0.3.0 --no-git-tag-version`
Then update `packages/scene-editor/src/bootstrap-version.ts` to `0.3.0` (must match `package.json` — asserted by `test/bootstrap-version.test.ts`).

- [ ] **Step 4: Full gate**

Run, in this order (perf is last and alone):

```powershell
pnpm typecheck
pnpm --filter @scenio/scene-editor test
pnpm build
pnpm test:pack
$env:CI=1; pnpm test:e2e --project=chromium critical-flows.spec.ts view-persistence.spec.ts
pnpm test:e2e:visual
pnpm test:perf
```

Expected: all green; test count ≥ 160.

- [ ] **Step 5: Update the master design doc** — mark the D22 TODO line in the user's design doc as implemented and note the shipped version (external file, not committed to the repo).

- [ ] **Step 6: Commit**

```bash
git add packages/scene-editor/README.md packages/scene-editor/API.md packages/scene-editor/package.json packages/scene-editor/src/bootstrap-version.ts
git commit -m "docs+release: document view state (D22) and bump to 0.3.0"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 decision 1–2 (scope = camera+lights+env, always on) | 2, 6 |
| §2 decision 3 (dirty, not undoable) | 1, 7 |
| §2 decision 4 (apply only on scene change) | 7 |
| §2 decision 5 (registry + literal version) | 2, 3 |
| §2 decision 6 (explicit paths only) | 7, 8 |
| §2 decision 7 (`background: null`) | 2, 6 |
| §3 data model + defaults | 2 |
| §4 data flow (all six layers) | 1, 5, 6, 7, 8, 9 |
| §5 migration + 3 error reasons | 3 |
| §6 observability (4 items) | 3 (`applied`), 4 (errors), 8 (`source`) |
| §6 known boundaries | 7 (sceneId gate incl. `applyRemote`), 3 (zod rejects missing view) |
| §7 testing | 1–10 |
| §8 impact (fixtures, v0.3.0, docs) | 4, 11 |
| §9 non-goals (nothing added) | — |

**Placeholder scan:** every code step carries literal code; no TBD/TODO. Task 4 Step 2 is a mechanical migration described by two explicit rules with an exact file list and a shared factory — the full replacement code is given in Step 1.

**Type consistency:** `ViewState` / `ViewStateSchema` / `SCHEMA_VERSION` / `createDefaultViewState` / `migrateSceneDocument` / `MigrationReport` / `ParseSceneDocumentOptions.onMigrate` / `getViewState` / `applyViewState` / `view-change` / `markDirty` / `handleRuntimeViewChange` / `setViewState` / `getSceneId` / `sceneDocument()` / `v1SceneDocument()` / `simulateViewChange()` are spelled identically everywhere they appear.
