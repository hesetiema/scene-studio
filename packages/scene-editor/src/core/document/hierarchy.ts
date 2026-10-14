import type { SceneObjectDTO } from "./schema";
import { SceneEditorError, SceneErrorCode } from "../events/errors";

/**
 * Parent-chain integrity for stable IDs (stage 2):
 * - unique ids
 * - parentId must reference an existing object
 * - no self-parenting
 * - no cycles
 */
export function validateHierarchy(objects: readonly SceneObjectDTO[]): void {
  const byId = new Map<string, SceneObjectDTO>();
  for (const o of objects) {
    if (byId.has(o.id)) {
      throw new SceneEditorError(
        SceneErrorCode.Validation,
        `Duplicate object id: ${o.id}`,
        { detail: { duplicateId: o.id } },
      );
    }
    byId.set(o.id, o);
  }

  for (const o of objects) {
    if (o.parentId === undefined) continue;
    if (o.parentId === o.id) {
      throw new SceneEditorError(
        SceneErrorCode.Validation,
        `Object ${o.id} cannot be its own parentId`,
        { detail: { id: o.id } },
      );
    }
    if (!byId.has(o.parentId)) {
      throw new SceneEditorError(
        SceneErrorCode.Validation,
        `Object ${o.id} references missing parentId: ${o.parentId}`,
        { detail: { id: o.id, parentId: o.parentId } },
      );
    }
  }

  for (const start of byId.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new SceneEditorError(
          SceneErrorCode.Validation,
          `Parent cycle detected at object: ${current}`,
          { detail: { id: current } },
        );
      }
      seen.add(current);
      const parentObj: SceneObjectDTO | undefined = byId.get(current);
      const parentId: string | undefined = parentObj ? parentObj.parentId : undefined;
      current = parentId !== undefined && byId.has(parentId) ? parentId : undefined;
    }
  }
}
