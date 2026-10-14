import { CommandHistory, type Command } from "../core/history/command-history";
import { TransformCommand } from "../core/commands/transform-command";
import { DisposerStack } from "./disposer-stack";
import { SelectionManager } from "./selection-manager";
import type { RuntimeContract, RuntimeEventMap, Transform } from "./runtime-contract";
import { parseSceneDocument } from "../core/document/parse";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type { SceneDocument } from "../core/document/schema";

/**
 * Sits between the element and the runtime: owns the Disposer stack (D8),
 * the command history, selection, the current document snapshot, and is the
 * single place that destroys the session.
 */
export class EditorController {
  readonly disposers = new DisposerStack();
  readonly history: CommandHistory;
  readonly selection: SelectionManager;

  #doc: SceneDocument | null = null;

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

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get dirty(): boolean {
    return this.history.dirty;
  }

  get selectedIds(): readonly string[] {
    return this.selection.ids;
  }

  executeCommand(command: Command): void {
    this.history.execute(command);
  }

  /** Transform edit: one command that updates runtime + stored document (D18). */
  applyTransform(id: string, from: Transform, to: Transform): void {
    this.executeCommand(
      new TransformCommand(id, from, to, (objectId, t) => {
        this.runtime.applyTransform(objectId, t);
        this.#patchTransform(objectId, t);
      }),
    );
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
    this.#doc = structuredClone(doc);
    this.history.clear();
    this.selection.clear();
  }

  /** Read-only detached snapshot — never the save trigger (D18). */
  getDocument(): SceneDocument {
    if (!this.#doc) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "No document loaded");
    }
    return structuredClone(this.#doc);
  }

  destroy(): void {
    this.disposers.flush();
  }

  #patchTransform(id: string, t: Transform): void {
    const obj = this.#doc?.objects.find((o) => o.id === id);
    if (!obj) return;
    obj.position = [t.position[0], t.position[1], t.position[2]];
    obj.rotation = [t.rotation[0], t.rotation[1], t.rotation[2]];
    obj.scale = [t.scale[0], t.scale[1], t.scale[2]];
  }
}
