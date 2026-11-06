import type { Command } from "../history/command-history";
import type { ObjectCommandOps } from "./object-command-ops";

/**
 * Move an object under another parent (`undefined` = scene root).
 *
 * Validity (existence, self-reference, cycles) is checked by the controller
 * before the command is created — the command itself is a pure two-way switch.
 */
export class ReparentCommand implements Command {
  readonly label = "reparent";

  constructor(
    readonly id: string,
    readonly from: string | undefined,
    readonly to: string | undefined,
    private readonly ops: ObjectCommandOps,
  ) {}

  execute(): void {
    this.ops.reparent(this.id, this.to);
    this.ops.patchParent(this.id, this.to);
  }

  undo(): void {
    this.ops.reparent(this.id, this.from);
    this.ops.patchParent(this.id, this.from);
  }
}
