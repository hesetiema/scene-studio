import { CommandHistory, type Command } from "../core/history/command-history";
import { DisposerStack } from "./disposer-stack";
import { SelectionManager } from "./selection-manager";
import type { RuntimeContract, RuntimeEventMap } from "./runtime-contract";
import { parseSceneDocument } from "../core/document/parse";

/**
 * Sits between the element and the runtime: owns the Disposer stack (D8),
 * the command history, selection, and is the single place that destroys the session.
 */
export class EditorController {
  readonly disposers = new DisposerStack();
  readonly history: CommandHistory;
  readonly selection: SelectionManager;

  constructor(readonly runtime: RuntimeContract) {
    this.history = new CommandHistory((state) => {
      const payload: RuntimeEventMap["history-change"] = {
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        dirty: state.dirty,
      };
      if (state.lastCommand !== undefined) {
        payload.lastCommand = state.lastCommand;
      }
      this.runtime.events.emit("history-change", payload);
    });
    this.selection = new SelectionManager((ids) => {
      this.runtime.events.emit("selection-change", { ids: [...ids] });
    });
  }

  get selectedIds(): readonly string[] {
    return this.selection.ids;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get dirty(): boolean {
    return this.history.dirty;
  }

  executeCommand(command: Command): void {
    this.history.execute(command);
  }

  undo(): boolean {
    return this.history.undo();
  }

  redo(): boolean {
    return this.history.redo();
  }

  markClean(): void {
    this.history.markClean();
  }

  select(ids: string[]): void {
    this.selection.set(ids);
    this.runtime.select([...this.selection.ids]);
  }

  clearSelection(): void {
    this.selection.clear();
    this.runtime.clearSelection();
  }

  async loadDocument(input: unknown): Promise<void> {
    const doc = parseSceneDocument(input);
    await this.runtime.loadDocument(doc);
    this.history.clear();
  }

  destroy(): void {
    this.disposers.flush();
  }
}
