import type { Command } from "../history/command-history";
import type { SceneObjectDTO } from "../document/schema";
import type { ObjectCommandOps } from "./object-command-ops";

/**
 * Add one object.
 *
 * The controller mounts it **before** running the command, because asset loading
 * is asynchronous and a document must never reference an object that failed to
 * load. So the first `execute` only touches the document; `#mounted` flips back
 * on undo, which makes a later redo mount again.
 */
export class AddObjectCommand implements Command {
  readonly label = "add-object";
  #mounted: boolean;

  constructor(
    readonly dto: SceneObjectDTO,
    private readonly ops: ObjectCommandOps,
    options: { mounted?: boolean } = {},
  ) {
    this.#mounted = options.mounted ?? false;
  }

  execute(): void {
    if (!this.#mounted) {
      this.ops.mount(this.dto);
      this.#mounted = true;
    }
    this.ops.insert(this.dto, -1);
  }

  undo(): void {
    this.ops.unmount(this.dto.id);
    this.ops.remove(this.dto.id);
    this.#mounted = false;
  }
}
