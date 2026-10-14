import { SceneEditorError, SceneErrorCode } from "./errors";
import type { SceneDocument } from "../document/schema";

export interface ConflictDocuments {
  /** Server state at the last known good revision (or the base the client edited from). */
  base: SceneDocument;
  /** Server's current state (what the save was rejected against). */
  incoming: SceneDocument;
  /** Client's local (unsaved) state. */
  local: SceneDocument;
}

/**
 * D17: structured conflict — SDK never auto-merges; host drives recovery.
 */
export function createConflictError(docs: ConflictDocuments): SceneEditorError {
  return new SceneEditorError(
    SceneErrorCode.Conflict,
    `Scene revision conflict: base r${docs.base.revision}, incoming r${docs.incoming.revision}, local r${docs.local.revision}`,
    { detail: { ...docs } },
  );
}
