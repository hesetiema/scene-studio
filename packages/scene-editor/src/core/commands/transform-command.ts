import type { Command } from "../history/command-history";
import type { Transform } from "../../runtime/runtime-contract";

/** One completed drag = one command (old → new transform for a single object). */
export class TransformCommand implements Command {
  readonly label = "transform";

  constructor(
    readonly objectId: string,
    readonly from: Transform,
    readonly to: Transform,
    private readonly apply: (id: string, t: Transform) => void,
  ) {}

  execute(): void {
    this.apply(this.objectId, this.to);
  }

  undo(): void {
    this.apply(this.objectId, this.from);
  }
}
