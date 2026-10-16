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
