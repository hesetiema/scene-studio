import type { Command } from "../history/command-history";
import type { SceneObjectDTO } from "../document/schema";
import type { ObjectCommandOps } from "./object-command-ops";

/** One entry of a cascade: the object plus where it sat in `objects`. */
export interface RemovedObject {
  readonly dto: SceneObjectDTO;
  readonly index: number;
}

/**
 * Remove an object **and its whole subtree**.
 *
 * The cascade list is captured up front (root first, then descendants, each with
 * its original index) so undo restores the exact array order rather than
 * appending the subtree to the end.
 */
export class RemoveObjectCommand implements Command {
  readonly label = "remove-object";

  constructor(
    private readonly removed: readonly RemovedObject[],
    private readonly ops: ObjectCommandOps,
  ) {}

  execute(): void {
    // Children leave before their parents: never orphan a live subtree.
    for (let i = this.removed.length - 1; i >= 0; i -= 1) {
      const { dto } = this.removed[i]!;
      this.ops.unmount(dto.id);
      this.ops.remove(dto.id);
    }
  }

  undo(): void {
    // Ascending index is what reproduces the original array order.
    for (const { dto, index } of this.removed) {
      this.ops.insert(dto, index);
      this.ops.mount(dto);
    }
  }
}
