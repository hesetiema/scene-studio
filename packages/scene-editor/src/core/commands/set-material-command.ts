import type { Command } from "../history/command-history";
import type { MaterialDTO } from "../document/schema";
import type { ObjectCommandOps } from "./object-command-ops";

/**
 * Replace or clear one object's material override.
 *
 * `undefined` means "no override": the runtime restores the materials the asset
 * shipped with. That is why the command stores the previous value whole instead
 * of diffing fields.
 *
 * Consecutive writes to the same object merge (see `Command.mergeWith`), so a
 * slider drag is one undo step whose `from` is the value before the drag.
 */
export class SetMaterialCommand implements Command {
  readonly label = "set-material";
  readonly id: string;
  readonly from: MaterialDTO | undefined;
  readonly #ops: ObjectCommandOps;
  #to: MaterialDTO | undefined;

  constructor(
    id: string,
    from: MaterialDTO | undefined,
    to: MaterialDTO | undefined,
    ops: ObjectCommandOps,
  ) {
    this.id = id;
    this.from = from;
    this.#to = to;
    this.#ops = ops;
  }

  get to(): MaterialDTO | undefined {
    return this.#to;
  }

  execute(): void {
    this.#ops.setMaterial(this.id, this.#to);
    this.#ops.patchMaterial(this.id, this.#to);
  }

  undo(): void {
    this.#ops.setMaterial(this.id, this.from);
    this.#ops.patchMaterial(this.id, this.from);
  }

  /** Absorb a later write to the same object; `from` stays the earliest value. */
  mergeWith(next: Command): boolean {
    if (!(next instanceof SetMaterialCommand) || next.id !== this.id) return false;
    this.#to = next.to;
    return true;
  }
}
