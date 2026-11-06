import { CommandHistory, type Command } from "../core/history/command-history";
import { TransformCommand } from "../core/commands/transform-command";
import { AddObjectCommand } from "../core/commands/add-object-command";
import { RemoveObjectCommand, type RemovedObject } from "../core/commands/remove-object-command";
import { ReparentCommand } from "../core/commands/reparent-command";
import { SetMaterialCommand } from "../core/commands/set-material-command";
import type { ObjectCommandOps } from "../core/commands/object-command-ops";
import { DisposerStack } from "./disposer-stack";
import { SelectionManager } from "./selection-manager";
import type { RuntimeContract, RuntimeEventMap, Transform } from "./runtime-contract";
import { parseSceneDocument } from "../core/document/parse";
import { validateHierarchy } from "../core/document/hierarchy";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import { createConflictError } from "../core/events/conflict";
import {
  MaterialSchema,
  SceneObjectSchema,
  type MaterialDTO,
  type SceneDocument,
  type SceneObjectDTO,
  type ViewState,
} from "../core/document/schema";

/** Collect an object plus every descendant, each with its original index. */
function collectSubtree(objects: readonly SceneObjectDTO[], rootId: string): RemovedObject[] {
  const indexOf = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();

  objects.forEach((object, index) => {
    indexOf.set(object.id, index);
    if (object.parentId === undefined) return;
    const siblings = childrenOf.get(object.parentId);
    if (siblings) siblings.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  });

  const removed: RemovedObject[] = [];
  const visit = (id: string): void => {
    const index = indexOf.get(id);
    const dto = index === undefined ? undefined : objects[index];
    if (index === undefined || dto === undefined) return;
    removed.push({ dto, index });
    for (const childId of childrenOf.get(id) ?? []) visit(childId);
  };
  visit(rootId);

  // Ascending index is what undo needs to restore the array order.
  return removed.sort((a, b) => a.index - b.index);
}

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

  /**
   * Runtime side is fire-and-forget (asset mounts resolve later) and document
   * side is synchronous; keeping both behind one interface is what lets the
   * command classes stay trivial and the validation live in exactly one place.
   */
  readonly #ops: ObjectCommandOps = {
    mount: (dto) => {
      const add = this.runtime.addObject;
      if (!add) throw this.#unsupported("addObject");
      const pending = add.call(this.runtime, dto);
      if (pending !== undefined && typeof pending.then === "function") {
        pending.catch((error: unknown) => this.#reportRuntimeError(error));
      }
    },
    unmount: (id) => {
      const remove = this.runtime.removeObject;
      if (!remove) throw this.#unsupported("removeObject");
      remove.call(this.runtime, id);
    },
    reparent: (id, parentId) => {
      const reparent = this.runtime.reparent;
      if (!reparent) throw this.#unsupported("reparent");
      reparent.call(this.runtime, id, parentId);
    },
    setMaterial: (id, material) => {
      const setMaterial = this.runtime.setMaterial;
      if (!setMaterial) throw this.#unsupported("setMaterial");
      setMaterial.call(this.runtime, id, material);
    },
    insert: (dto, index) => this.#insertObject(dto, index),
    remove: (id) => this.#deleteObject(id),
    patchParent: (id, parentId) => this.#patchParent(id, parentId),
    patchMaterial: (id, material) => this.#patchMaterial(id, material),
  };

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

  /**
   * Add one object. Async because an asset-backed object is only valid once its
   * file is live — the document is never allowed to reference an object whose
   * asset failed to load.
   */
  async addObject(input: SceneObjectDTO): Promise<void> {
    const doc = this.#requireDocument();
    const dto = SceneObjectSchema.parse(input);
    if (doc.objects.some((object) => object.id === dto.id)) {
      throw new SceneEditorError(SceneErrorCode.Validation, `Duplicate object id: ${dto.id}`, {
        detail: { duplicateId: dto.id },
      });
    }
    validateHierarchy([...doc.objects, dto]);

    const add = this.runtime.addObject;
    if (!add) throw this.#unsupported("addObject");
    await add.call(this.runtime, dto);

    this.history.execute(new AddObjectCommand(dto, this.#ops, { mounted: true }));
  }

  /** Remove an object and its whole subtree in one undoable step. */
  removeObject(id: string): void {
    const doc = this.#requireDocument();
    if (!doc.objects.some((object) => object.id === id)) {
      throw new SceneEditorError(SceneErrorCode.Validation, `Unknown object id: ${id}`, {
        detail: { id },
      });
    }
    this.history.execute(new RemoveObjectCommand(collectSubtree(doc.objects, id), this.#ops));
    // Removing a selected object leaves the selection pointing at nothing.
    this.#pruneSelection();
  }

  /** Move an object under another parent (`undefined` = scene root). */
  reparent(id: string, parentId: string | undefined): void {
    const doc = this.#requireDocument();
    const object = doc.objects.find((candidate) => candidate.id === id);
    if (!object) {
      throw new SceneEditorError(SceneErrorCode.Validation, `Unknown object id: ${id}`, {
        detail: { id },
      });
    }

    const next = doc.objects.map((candidate) => {
      if (candidate.id !== id) return candidate;
      const copy = { ...candidate };
      if (parentId === undefined) delete copy.parentId;
      else copy.parentId = parentId;
      return copy;
    });
    // Expressed as an array first, so the same rules a loaded document obeys
    // (missing parent, self-parenting, cycles) reject the edit.
    validateHierarchy(next);

    this.history.execute(new ReparentCommand(id, object.parentId, parentId, this.#ops));
  }

  /** Replace or clear one object's material override (`undefined` = clear). */
  setMaterial(id: string, material: MaterialDTO | undefined): void {
    const doc = this.#requireDocument();
    const object = doc.objects.find((candidate) => candidate.id === id);
    if (!object) {
      throw new SceneEditorError(SceneErrorCode.Validation, `Unknown object id: ${id}`, {
        detail: { id },
      });
    }

    const next = material === undefined ? undefined : MaterialSchema.parse(material);
    if (next !== undefined && object.type === "group") {
      throw new SceneEditorError(SceneErrorCode.Validation, `Group ${id} cannot carry a material`, {
        detail: { id },
      });
    }

    this.history.execute(new SetMaterialCommand(id, object.material, next, this.#ops));
  }

  undo(): boolean {
    const changed = this.history.undo();
    if (changed) this.#pruneSelection();
    return changed;
  }

  redo(): boolean {
    const changed = this.history.redo();
    if (changed) this.#pruneSelection();
    return changed;
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

  #requireDocument(): SceneDocument {
    if (!this.#doc) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "No document loaded");
    }
    return this.#doc;
  }

  #unsupported(method: string): SceneEditorError {
    return new SceneEditorError(
      SceneErrorCode.Lifecycle,
      `Runtime does not support ${method}; object commands need an incremental runtime`,
    );
  }

  /** Redo mounts asynchronously, so a late asset failure lands here. */
  #reportRuntimeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SceneEditorError ? error.code : SceneErrorCode.AssetLoadFailed;
    this.runtime.events.emit("error", {
      code,
      message,
      ...(error instanceof Error ? { cause: error } : {}),
    });
  }

  #insertObject(dto: SceneObjectDTO, index: number): void {
    const doc = this.#requireDocument();
    const objects = [...doc.objects];
    if (index < 0 || index >= objects.length) objects.push(dto);
    else objects.splice(index, 0, dto);
    this.#doc = { ...doc, objects };
  }

  #deleteObject(id: string): void {
    const doc = this.#requireDocument();
    this.#doc = { ...doc, objects: doc.objects.filter((object) => object.id !== id) };
  }

  #patchParent(id: string, parentId: string | undefined): void {
    const doc = this.#requireDocument();
    const objects = doc.objects.map((object) => {
      if (object.id !== id) return object;
      const copy = { ...object };
      if (parentId === undefined) delete copy.parentId;
      else copy.parentId = parentId;
      return copy;
    });
    this.#doc = { ...doc, objects };
  }

  #patchMaterial(id: string, material: MaterialDTO | undefined): void {
    const doc = this.#requireDocument();
    const objects = doc.objects.map((object) => {
      if (object.id !== id) return object;
      const copy = { ...object };
      if (material === undefined) delete copy.material;
      else copy.material = { ...material };
      return copy;
    });
    this.#doc = { ...doc, objects };
  }

  /** A command may delete what is selected; a dangling selection never ships. */
  #pruneSelection(): void {
    const ids = this.selection.ids;
    if (ids.length === 0) return;
    const alive = ids.filter((id) => this.#doc?.objects.some((object) => object.id === id));
    if (alive.length !== ids.length) this.select([...alive]);
  }
}
