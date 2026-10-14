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
  #dirty = false;
  #lastCommand?: string;

  constructor(private readonly onChange?: (state: HistoryState) => void) {}

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  execute(command: Command): void {
    command.execute();
    this.#undoStack.push(command);
    this.#redoStack = [];
    this.#dirty = true;
    this.#lastCommand = command.label;
    this.#notify();
  }

  undo(): boolean {
    const command = this.#undoStack.pop();
    if (!command) return false;
    command.undo();
    this.#redoStack.push(command);
    this.#dirty = true;
    this.#lastCommand = command.label;
    this.#notify();
    return true;
  }

  redo(): boolean {
    const command = this.#redoStack.pop();
    if (!command) return false;
    command.execute();
    this.#undoStack.push(command);
    this.#dirty = true;
    this.#lastCommand = command.label;
    this.#notify();
    return true;
  }

  markClean(): void {
    this.#dirty = false;
    this.#notify();
  }

  clear(): void {
    this.#undoStack = [];
    this.#redoStack = [];
    this.#dirty = false;
    this.#lastCommand = undefined;
    this.#notify();
  }

  #notify(): void {
    if (!this.onChange) return;
    const state: HistoryState = {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      dirty: this.#dirty,
    };
    if (this.#lastCommand !== undefined) {
      state.lastCommand = this.#lastCommand;
    }
    this.onChange(state);
  }
}
