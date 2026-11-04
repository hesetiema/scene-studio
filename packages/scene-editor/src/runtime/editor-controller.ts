import { CommandHistory, type Command } from "../core/history/command-history";
import { TransformCommand } from "../core/commands/transform-command";
import { DisposerStack } from "./disposer-stack";
import { SelectionManager } from "./selection-manager";
import type { RuntimeContract, RuntimeEventMap, Transform } from "./runtime-contract";
import { parseSceneDocument } from "../core/document/parse";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import { createConflictError } from "../core/events/conflict";
import type { SceneDocument, ViewState } from "../core/document/schema";

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
  #baseRevision = 0;
  /**
   * Loads are serialized: `loadDocument` clears and repopulates the scene, so
   * overlapping calls used to interleave `clear()` with another call's async
   * asset mounts (duplicated objects, orphaned meshes, document/scene mismatch).
   * Call order decides the final document; failures never poison the chain.
   */
  #loadChain: Promise<void> = Promise.resolve();

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
    // Interaction-driven view changes are recorded (dirty, not undoable, D22).
    this.runtime.events.on("view-change", ({ view }) => this.handleRuntimeViewChange(view));
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

  get revision(): number {
    return this.#doc?.revision ?? this.#baseRevision;
  }

  /** Scene id of the loaded document, or null before the first load (D22). */
  getSceneId(): string | null {
    return this.#doc?.sceneId ?? null;
  }

  /** Live viewport view from the runtime — never the save trigger (D22). */
  getViewState(): ViewState {
    return this.runtime.getViewState();
  }

  /**
   * Explicit host-driven view update: recorded in the document, marked dirty,
   * never part of the undo stack (D22).
   */
  setViewState(view: ViewState): void {
    if (!this.#doc) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "No document loaded");
    }
    this.#doc = { ...this.#doc, view: structuredClone(view) };
    this.runtime.applyViewState(view);
    this.history.markDirty();
  }

  /** Runtime reported a user interaction — record it and mark dirty (D22). */
  handleRuntimeViewChange(view: ViewState): void {
    if (!this.#doc) return;
    this.#doc = { ...this.#doc, view: structuredClone(view) };
    this.history.markDirty();
  }

  /** Host confirmed save: adopt server revision and clear dirty (D17/D18). */
  markSaved(serverRevision: number): void {
    if (this.#doc) {
      this.#doc = { ...this.#doc, revision: serverRevision };
    }
    this.#baseRevision = serverRevision;
    this.history.markClean();
  }

  /**
   * Apply a remote document. Fast-forwards only when there are no local edits
   * and the remote is the exact next revision; otherwise throws a structured
   * conflict (synchronously) for the host to resolve (D17 — SDK never auto-merges).
   */
  applyRemote(
    remoteInput: unknown,
    options: { baseRevision: number },
  ): Promise<void> {
    const remote = parseSceneDocument(remoteInput);
    const local = this.#doc;
    if (local && this.history.dirty) {
      throw createConflictError({
        base: { ...local, revision: options.baseRevision },
        incoming: remote,
        local,
      });
    }
    const expected = options.baseRevision + 1;
    if (remote.revision !== expected) {
      throw createConflictError({
        base: local
          ? { ...local, revision: options.baseRevision }
          : { ...remote, revision: options.baseRevision },
        incoming: remote,
        local: local ?? { ...remote, revision: options.baseRevision },
      });
    }
    // The swap joins the same chain as loadDocument: runtime.loadDocument
    // clears the scene, so overlapping swaps corrupt the object graph.
    const run = this.#loadChain.then(() => this.#applyRemoteDocument(remote));
    this.#loadChain = run.catch(() => {
      // keep the chain usable after a failed remote swap
    });
    return run;
  }

  async #applyRemoteDocument(remote: SceneDocument): Promise<void> {
    await this.runtime.loadDocument(remote);
    const sceneChanged = this.#doc?.sceneId !== remote.sceneId;
    this.#doc = structuredClone(remote);
    this.#baseRevision = remote.revision;
    this.history.clear();
    this.selection.clear();
    if (sceneChanged) this.runtime.applyViewState(remote.view);
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
    // Validate before queueing: invalid input must reject without touching a
    // load that is already in flight.
    const doc = parseSceneDocument(input);
    const run = this.#loadChain.then(() => this.#applyDocument(doc));
    this.#loadChain = run.catch(() => {
      // a failed load must not stall the next one
    });
    return run;
  }

  async #applyDocument(doc: SceneDocument): Promise<void> {
    await this.runtime.loadDocument(doc);
    const sceneChanged = this.#doc?.sceneId !== doc.sceneId;
    this.#doc = structuredClone(doc);
    this.#baseRevision = doc.revision;
    this.history.clear();
    this.selection.clear();
    if (sceneChanged) this.runtime.applyViewState(doc.view);
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
