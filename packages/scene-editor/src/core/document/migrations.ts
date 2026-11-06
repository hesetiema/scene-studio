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

/**
 * v3 widened the document instead of reshaping it: `primitive` + `geometry` +
 * `material` on objects, `view.lights.additional` on the view. Both are
 * optional, so a v2 document is already structurally valid v3 — the step only
 * stamps the version.
 */
function v2ToV3(doc: RawDocument): RawDocument {
  const next: RawDocument = { ...doc };
  next.schemaVersion = 3;
  return next;
}

/** Append-only; each entry must advance exactly one version (D7/D22). */
export const migrations: readonly Migration[] = [
  { from: 1, to: 2, migrate: v1ToV2 },
  { from: 2, to: 3, migrate: v2ToV3 },
];

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
    throw migrationError("unsupported-schema-version", `Unsupported schemaVersion ${version}`, {
      found: version,
      supported: [1, SCHEMA_VERSION],
    });
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
