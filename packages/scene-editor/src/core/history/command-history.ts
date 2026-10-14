export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
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
  #lastCommand: string | undefined;

  constructor(private readonly onChange?: (state: HistoryState) => void) {}

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get dirty(): boolean {
    return this.#undoStack.length !== this.#cleanIndex;
  }

  execute(command: Command): void {
    // If the clean point lived in the redo branch we are about to discard,
    // invalidate it so a new command at the same depth is still dirty.
    if (this.#cleanIndex > this.#undoStack.length) {
      this.#cleanIndex = -1;
    }
    command.execute();
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
    this.#cleanIndex = this.#undoStack.length;
    this.#notify();
  }

  clear(): void {
    this.#undoStack = [];
    this.#redoStack = [];
    this.#cleanIndex = 0;
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
