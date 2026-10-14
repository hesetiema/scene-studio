import { SceneDocumentSchema, type SceneDocument } from "./schema";
import { SceneEditorError, SceneErrorCode } from "../events/errors";

export function parseSceneDocument(input: unknown): SceneDocument {
  const result = SceneDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new SceneEditorError(SceneErrorCode.Validation, "Invalid SceneDocument", {
      cause: result.error,
      detail: { issues: result.error.issues },
    });
  }
  return result.data;
}
