import type { MaterialDTO, SceneObjectDTO } from "../document/schema";

/**
 * The bridge between a command and the two places its effect has to land: the
 * live scene and the document.
 *
 * Kept as an interface so commands stay pure ordering + intent — all validation,
 * error reporting and dirty marking lives in `EditorController`.
 */
export interface ObjectCommandOps {
  /** Runtime side. Fire-and-forget: asset failures surface on the `error` event. */
  mount(dto: SceneObjectDTO): void;
  unmount(id: string): void;
  reparent(id: string, parentId: string | undefined): void;
  setMaterial(id: string, material: MaterialDTO | undefined): void;

  /** Document side. `index < 0` appends. */
  insert(dto: SceneObjectDTO, index: number): void;
  remove(id: string): void;
  patchParent(id: string, parentId: string | undefined): void;
  patchMaterial(id: string, material: MaterialDTO | undefined): void;
}
