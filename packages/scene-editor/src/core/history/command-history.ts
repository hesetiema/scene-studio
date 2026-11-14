export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
  /**
   * Absorb `next` into this command (already executed) instead of pushing it.
   *
   * This is what keeps a material slider drag from spending 40 undo steps on one
   * gesture: each tick is a real command, but consecutive writes to the same
   * object collapse into the first one, which keeps its original `from`.
   *
   * Return `true` when `next` was absorbed.
   */
  mergeWith?(next: Command): boolean;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  lastCommand?: string;
}

export class CommandHistory {
  #undoStack: Command[] = [];
  #redoStack: Command[] = [];
  /** Depth of undoStack at the last clean point (save/load). */
  #cleanIndex = 0;
  /** True when state changed outside the command stack (e.g. camera, D22). */
  #externalDirty = false;
  #lastCommand: string | undefined;

  constructor(private readonly onChange?: (state: HistoryState) => void) {}

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get dirty(): boolean {
    return this.#externalDirty || this.#undoStack.length !== this.#cleanIndex;
  }

  /**
   * Raise or lower the "changed outside the command stack" flag (view edits, D22).
   *
   * Deliberately not a one-way latch: a view change has no undo step, so the only
   * way a host can take it back is by restoring the saved pose itself. Latching
   * on the first write made `dirty` a lie after such an undo — the footer kept
   * reporting unsaved work on a document identical to the server's copy. Clearing
   * is safe because it is the caller's comparison that decides, and a false
   * negative just leaves the document dirty.
   */
  setExternalDirty(dirty: boolean): void {
    if (this.#externalDirty === dirty) return;
    this.#externalDirty = dirty;
    this.#notify();
  }

  /** Mark dirty from a non-command change (camera/lights/environment, D22). */
  markDirty(): void {
    this.setExternalDirty(true);
  }

  execute(command: Command): void {
    // If the clean point lived in the redo branch we are about to discard,
    // invalidate it so a new command at the same depth is still dirty.
    if (this.#cleanIndex > this.#undoStack.length) {
      this.#cleanIndex = -1;
    }

    // Apply first: a merge still has to reach the runtime and the document.
    command.execute();

    const top = this.#undoStack[this.#undoStack.length - 1];
    if (top !== undefined && top !== command && top.mergeWith?.(command) === true) {
      // The absorbed command is now redundant — the top command owns both ends.
      this.#redoStack = [];
      this.#lastCommand = command.label;
      this.#notify();
      return;
    }

    this.#undoStack.push(command);
    this.#redoStack = [];
    this.#lastCommand = command.label;
    this.#notify();
  }

  undo(): boolean {
    const command = this.#undoStack.pop();
    if (!command) return false;
    command.undo();
    this.#redoStack.push(command);
    this.#lastCommand = command.label;
    this.#notify();
    return true;
  }

  redo(): boolean {
    const command = this.#redoStack.pop();
    if (!command) return false;
    command.execute();
    this.#undoStack.push(command);
    this.#lastCommand = command.label;
    this.#notify();
    return true;
  }

  /** Anchor the clean point at the current undo depth (after host save). */
  markClean(): void {
    this.#externalDirty = false;
    this.#cleanIndex = this.#undoStack.length;
    this.#notify();
  }

  clear(): void {
    this.#undoStack = [];
    this.#redoStack = [];
    this.#cleanIndex = 0;
    this.#externalDirty = false;
    this.#lastCommand = undefined;
    this.#notify();
  }

  #notify(): void {
    if (!this.onChange) return;
    const state: HistoryState = {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      dirty: this.dirty,
    };
    if (this.#lastCommand !== undefined) {
      state.lastCommand = this.#lastCommand;
    }
    this.onChange(state);
  }
}
