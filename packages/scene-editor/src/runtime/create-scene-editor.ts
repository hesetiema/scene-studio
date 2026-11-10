import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type {
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";
import { EditorController } from "./editor-controller";
import type { Command } from "../core/history/command-history";
import { PluginHost, type PluginHostEditor } from "./plugin-host";
import { handleEditorKeyCommand, type KeyboardLike } from "./keyboard";
import type { RuntimeContract, Transform } from "./runtime-contract";
import type { SceneEditorPlugin } from "../plugins/plugin";

/** Facade event map — element event names carried over one-for-one (no DOM). */
export type SceneEditorEventMap = {
  "selection-change": { ids: string[] };
  "history-change": {
    canUndo: boolean;
    canRedo: boolean;
    dirty: boolean;
    lastCommand?: string;
  };
  /** Dirty crossed false↔true (mirrors the element's document-dirty event). */
  "document-dirty": { dirty: boolean };
  /** Host should persist `document` now; confirm with markSaved(serverRevision). */
  "save-request": {
    reason: "manual";
    document: SceneDocument;
    revision: number;
  };
  /**
   * Viewport view changed (D22). source: "interaction" (user gesture),
   * "api" (host called setViewState), "load" (documented view applied for a new scene).
   */
  "view-change": { view: ViewState; source: "interaction" | "api" | "load" };
  /**
   * In-flight view sample while the camera is moving (D22). Only emitted when
   * the host opted in through the runtime's `setLiveViewEvents(true)` (element:
   * the `live-view-events` attribute). High frequency — do not persist on it.
   */
  "view-changing": { view: ViewState };
  /**
   * Camera pose sample whenever the camera actually moved (drag, damping,
   * auto-rotate). Same cadence as the runtime sample — cheap, camera-only.
   * Never emitted from `applyViewState` (that is not user motion).
   */
  "camera-change": ViewState["camera"];
  /**
   * The environment slice of the view changed (background / grid / IBL / HDR /
   * contact shadow). Edge-triggered: only fires when the payload differs.
   */
  "environment-change": {
    environment: ViewState["environment"];
    source: "api" | "load";
  };
  /**
   * Element-only: `visibility-change` under the viewer-compatible name. The
   * headless facade owns no DOM, so this never fires from `editor.on(...)`.
   */
  "model-visibility": { visible: boolean };
  /**
   * Element-only: the poster slot was dismissed (auto after load, on the first
   * interaction, or through `dismissPoster()`). No DOM in the facade, so no
   * emission from `editor.on(...)`.
   */
  "poster-dismissed": Record<string, never>;
  /**
   * Aggregate load progress (0..1), monotonic per load. `reason` names the
   * activity ("model-load"). Safe for a progress bar; not a success signal —
   * a failed load still ends at 1.
   */
  progress: { totalProgress: number; reason: string };
  /** The document finished loading and the runtime is renderable. */
  load: { sceneId: string };
  /**
   * Animation transport — model-viewer's `play` / `pause` / `loop` /
   * `finished`. Low frequency: one per clip start, wrap or end, so a viewer can
   * drive transport chrome from them without sampling every frame.
   */
  play: { objectId: string; index: number; name: string };
  /** Edge-only: a viewer starts paused, so this never fires on load. */
  pause: Record<string, never>;
  /** The clip in flight completed a wrap; `count` starts at 1. */
  loop: { count: number; name: string };
  /** A one-shot clip (`pause-at-end`) reached its last frame. */
  finished: { objectId: string; name: string };
  /**
   * Element-only: the `<scene-editor>` host entered or left the viewport.
   * The headless facade owns no DOM, so `editor.on("visibility-change")` never
   * fires — listen on the element instead.
   */
  "visibility-change": { visible: boolean };
  error: { code: string; message: string; cause?: unknown };
};

/**
 * Full element contract: facade events plus the two DOM-only ones. Element
 * listeners are typed against this map; `SceneEditorEventMap` deliberately
 * still carries `visibility-change` so one import describes both surfaces.
 */
export type SceneEditorElementEventMap = Omit<SceneEditorEventMap, "load"> & {
  /** Init finished; canvas + runtime live. `detail` is `null` (no payload). */
  "scene-ready": null;
  /** The element adds the `src` URL; headless hosts get `url: null`. */
  load: { sceneId: string; url: string | null };
};

export interface CreateSceneEditorOptions {
  /**
   * Required. Test with FakeRuntime, production with ThreeRuntime, or any
   * RuntimeContract implementation — the facade never imports three.
   */
  runtime: RuntimeContract;
}

/** Headless editor facade: state + commands + typed events + plugins, zero DOM. */
export interface SceneEditor {
  readonly runtime: RuntimeContract;

  loadDocument(doc: unknown): Promise<void>;
  getDocument(): SceneDocument;
  markSaved(serverRevision: number): void;
  /** Inbound remote update; throws structured conflict unless fast-forward-able (D17). */
  applyRemote(
    input: unknown,
    options: { baseRevision: number },
  ): Promise<void>;

  select(ids: string[]): void;
  add(ids: string[]): void;
  remove(ids: string[]): void;
  toggle(id: string): void;
  clearSelection(): void;

  applyTransform(id: string, from: Transform, to: Transform): void;

  /**
   * Object commands. `add`/`remove` above are *selection* helpers — these edit
   * the scene graph and the document, and join the undo stack.
   */
  addObject(dto: SceneObjectDTO): Promise<void>;
  removeObject(id: string): void;
  reparent(id: string, parentId: string | undefined): void;
  setMaterial(id: string, material: MaterialDTO | undefined): void;

  /** First-class entry for host-defined undoable actions (compare: PC history.add). */
  executeCommand(command: Command): void;
  undo(): boolean;
  redo(): boolean;

  requestSave(): void;

  /** Current runtime viewport view (live truth; the document is the last recorded one, D22). */
  getViewState(): ViewState;
  /** Explicitly record + apply a view. Marks dirty without entering the undo stack (D22). */
  setViewState(view: ViewState): void;

  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  readonly revision: number;
  readonly selectedIds: readonly string[];

  on<K extends keyof SceneEditorEventMap>(
    type: K,
    handler: (payload: SceneEditorEventMap[K]) => void,
  ): () => void;

  use(plugin: SceneEditorPlugin): void;
  unuse(id: string): void;

  /** Host forwards key events here; returns true when the facade consumed it. */
  handleKeyDown(event: KeyboardLike): boolean;

  destroy(): void;
}

class SceneEditorFacade implements SceneEditor, PluginHostEditor {
  readonly runtime: RuntimeContract;
  readonly #controller: EditorController;
  readonly #plugins: PluginHost;
  readonly #handlers = new Map<
    keyof SceneEditorEventMap,
    Set<(payload: never) => void>
  >();
  #lastDirty = false;
  #destroyed = false;

  constructor(options: CreateSceneEditorOptions) {
    this.runtime = options.runtime;
    this.#controller = new EditorController(options.runtime);
    this.#plugins = new PluginHost(options.runtime, this, (code, message, cause) => {
      this.#emit("error", { code, message, cause });
    });

    this.runtime.events.on("selection-change", (payload) => {
      this.#emit("selection-change", { ids: [...payload.ids] });
    });
    this.runtime.events.on("history-change", (payload) => {
      this.#emit("history-change", payload);
      if (payload.dirty !== this.#lastDirty) {
        this.#lastDirty = payload.dirty;
        this.#emit("document-dirty", { dirty: payload.dirty });
      }
    });
    // The controller records the view on the document; the facade attributes the source.
    this.runtime.events.on("view-change", ({ view }) => {
      this.#emit("view-change", { view, source: "interaction" });
    });
    // Live sampling is opt-in at the runtime seam; forward verbatim when it fires.
    this.runtime.events.on("view-changing", ({ view }) => {
      this.#emit("view-changing", { view });
    });
    // Camera-only samples are always on (auto-rotate would otherwise be silent).
    this.runtime.events.on("camera-change", (camera) => {
      this.#emit("camera-change", camera);
    });
    this.runtime.events.on("load-progress", (payload) => {
      this.#emit("progress", payload);
    });
    this.runtime.events.on("load", (payload) => {
      this.#emit("load", payload);
    });
    // Playback transport: the runtime's rig owns the transitions, the facade
    // only re-labels them (same shape, so a forward is enough).
    this.runtime.events.on("play", (payload) => {
      this.#emit("play", payload);
    });
    this.runtime.events.on("pause", () => {
      this.#emit("pause", {});
    });
    this.runtime.events.on("loop", (payload) => {
      this.#emit("loop", payload);
    });
    this.runtime.events.on("finished", (payload) => {
      this.#emit("finished", payload);
    });
    // Runtime failures (asset resolve/load, render) are one error channel for
    // hosts — the element docs promise `error` is the reliable surface (D6).
    this.runtime.events.on("error", (payload) => {
      this.#emit("error", payload);
    });
    this.#plugins.flushPending();
  }

  async loadDocument(doc: unknown): Promise<void> {
    this.#assertLive();
    const previousSceneId = this.#controller.getSceneId();
    // The controller only re-applies the view on a scene switch, so that is the
    // only path where the runtime environment can actually change.
    const previousEnvironment =
      previousSceneId === null
        ? undefined
        : this.#controller.getDocument().view.environment;
    try {
      await this.#controller.loadDocument(doc);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
    const current = this.#controller.getDocument();
    if (current.sceneId !== previousSceneId) {
      this.#emit("view-change", { view: current.view, source: "load" });
      // First load has no baseline to compare against — stay edge-triggered.
      if (previousEnvironment !== undefined && !sameValue(previousEnvironment, current.view.environment)) {
        this.#emit("environment-change", {
          environment: current.view.environment,
          source: "load",
        });
      }
    }
  }

  getDocument(): SceneDocument {
    this.#assertLive();
    return this.#controller.getDocument();
  }

  markSaved(serverRevision: number): void {
    this.#assertLive();
    this.#controller.markSaved(serverRevision);
  }

  applyRemote(input: unknown, options: { baseRevision: number }): Promise<void> {
    this.#assertLive();
    try {
      return this.#controller.applyRemote(input, options);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
  }

  select(ids: string[]): void {
    this.#assertLive();
    this.#controller.select(ids);
  }

  add(ids: string[]): void {
    this.#assertLive();
    this.#controller.select([...new Set([...this.#controller.selectedIds, ...ids])]);
  }

  remove(ids: string[]): void {
    this.#assertLive();
    const drop = new Set(ids);
    this.#controller.select(this.#controller.selectedIds.filter((id) => !drop.has(id)));
  }

  toggle(id: string): void {
    if (this.#controller.selection.isSelected(id)) this.remove([id]);
    else this.add([id]);
  }

  clearSelection(): void {
    this.#assertLive();
    this.#controller.clearSelection();
  }

  applyTransform(id: string, from: Transform, to: Transform): void {
    this.#assertLive();
    this.#controller.applyTransform(id, from, to);
  }

  async addObject(dto: SceneObjectDTO): Promise<void> {
    this.#assertLive();
    try {
      await this.#controller.addObject(dto);
    } catch (err) {
      this.#emitError(err);
      throw err;
    }
  }

  removeObject(id: string): void {
    this.#assertLive();
    this.#controller.removeObject(id);
  }

  reparent(id: string, parentId: string | undefined): void {
    this.#assertLive();
    this.#controller.reparent(id, parentId);
  }

  setMaterial(id: string, material: MaterialDTO | undefined): void {
    this.#assertLive();
    this.#controller.setMaterial(id, material);
  }

  executeCommand(command: Command): void {
    this.#assertLive();
    this.#controller.executeCommand(command);
  }

  undo(): boolean {
    this.#assertLive();
    return this.#controller.undo();
  }

  redo(): boolean {
    this.#assertLive();
    return this.#controller.redo();
  }

  requestSave(): void {
    this.#assertLive();
    const document = this.#controller.getDocument();
    this.#emit("save-request", {
      reason: "manual",
      document,
      revision: document.revision,
    });
  }

  getViewState(): ViewState {
    this.#assertLive();
    return this.#controller.getViewState();
  }

  setViewState(view: ViewState): void {
    this.#assertLive();
    const previousEnvironment =
      this.#controller.getSceneId() === null
        ? undefined
        : this.#controller.getDocument().view.environment;
    this.#controller.setViewState(view);
    const current = this.#controller.getDocument().view;
    this.#emit("view-change", { view: current, source: "api" });
    if (previousEnvironment !== undefined && !sameValue(previousEnvironment, current.environment)) {
      this.#emit("environment-change", { environment: current.environment, source: "api" });
    }
  }

  get canUndo(): boolean {
    return this.#controller.canUndo;
  }

  get canRedo(): boolean {
    return this.#controller.canRedo;
  }

  get dirty(): boolean {
    return this.#controller.dirty;
  }

  get revision(): number {
    return this.#controller.revision;
  }

  get selectedIds(): readonly string[] {
    return this.#controller.selectedIds;
  }

  on<K extends keyof SceneEditorEventMap>(
    type: K,
    handler: (payload: SceneEditorEventMap[K]) => void,
  ): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  use(plugin: SceneEditorPlugin): void {
    this.#assertLive();
    this.#plugins.use(plugin);
  }

  unuse(id: string): void {
    this.#plugins.unuse(id);
  }

  handleKeyDown(event: KeyboardLike): boolean {
    this.#assertLive();
    return handleEditorKeyCommand(this.#controller, event);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#plugins.teardown();
    this.#controller.destroy();
    // Full teardown: controller flushes its stack; the runtime contract's
    // flushDisposers releases GPU/scene resources (host-owned lifetime, D5).
    try {
      this.runtime.flushDisposers();
    } catch (err) {
      this.#emitError(err);
    }
    this.#handlers.clear();
  }

  #assertLive(): void {
    if (this.#destroyed) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor destroyed");
    }
  }

  #emit<K extends keyof SceneEditorEventMap>(
    type: K,
    payload: SceneEditorEventMap[K],
  ): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      (handler as (p: SceneEditorEventMap[K]) => void)(payload);
    }
  }

  #emitError(err: unknown): void {
    if (err instanceof SceneEditorError) {
      this.#emit("error", { code: err.code, message: err.message, cause: err.cause });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      this.#emit("error", { code: SceneErrorCode.Lifecycle, message, cause: err });
    }
  }
}

/** Structural equality for the small plain-JSON view slices (environment). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Create a headless editor: no DOM, no canvas, no CustomEvent.
 * The host owns UI and input wiring; this owns state, history, selection,
 * plugins, and typed events.
 *
 * ```ts
 * const editor = createSceneEditor({ runtime: new FakeRuntime() });
 * await editor.loadDocument(doc);
 * editor.on("save-request", ({ document }) => persist(document));
 * ```
 */
export function createSceneEditor(options: CreateSceneEditorOptions): SceneEditor {
  return new SceneEditorFacade(options);
}
