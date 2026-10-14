import { DisposerStack } from "./disposer-stack";
import type { RuntimeContract } from "./runtime-contract";

/**
 * Sits between the element and the runtime: owns the Disposer stack (D8)
 * and is the single place that destroys the editing session.
 */
export class EditorController {
  readonly disposers = new DisposerStack();

  constructor(readonly runtime: RuntimeContract) {}

  destroy(): void {
    this.disposers.flush();
  }
}
