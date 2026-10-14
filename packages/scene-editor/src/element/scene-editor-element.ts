import { EditorController } from "../runtime/editor-controller";
import { SceneEditorError, SceneErrorCode } from "../core/events/errors";
import type { RuntimeContract, Transform } from "../runtime/runtime-contract";
import type { SceneDocument } from "../core/document/schema";
import { ThreeRuntime } from "../three/three-runtime";

export type SceneEditorRuntimeFactory = (canvas: HTMLCanvasElement) => RuntimeContract;

/** Keyboard capture list (D20) — documented for hosts. */
export const CAPTURED_COMBOS = ["ctrl+z", "ctrl+shift+z", "ctrl+y", "g", "r", "s"] as const;

export class SceneEditorElement extends HTMLElement {
  /** Injectable seam for tests; defaults to real ThreeRuntime (D1). */
  static runtimeFactory: SceneEditorRuntimeFactory = (canvas) => new ThreeRuntime({ canvas });

  #controller: EditorController | null = null;
  #ready!: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (err: unknown) => void;
  #abort: AbortController | null = null;
  #lastDirty = false;
  #wasDisconnected = false;

  constructor() {
    super();
    this.#resetReady();
    // Internal no-op catch: unawaited ready must not raise unhandledrejection (D20).
    this.#ready.catch(() => {});
  }

  /** Resolves on init; rejects on failure. Prefer the error event as the必发面 (D6/D20). */
  get ready(): Promise<void> {
    return this.#ready;
  }

  connectedCallback(): void {
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }
    if (this.#controller) return;
    if (this.#wasDisconnected) {
      this.#resetReady();
      this.#ready.catch(() => {});
      this.#wasDisconnected = false;
    }
    void this.#init();
  }

  disconnectedCallback(): void {
    this.#wasDisconnected = true;
    this.#abort?.abort();
    this.#abort = null;
    const controller = this.#controller;
    this.#controller = null;
    try {
      controller?.destroy();
    } catch (err) {
      this.#emitError(SceneErrorCode.Lifecycle, "Controller destroy failed", err);
    }
  }

  async loadDocument(doc: unknown): Promise<void> {
    performance.mark("scene-editor:load:start");
    try {
      await this.#requireController().loadDocument(doc);
    } finally {
      performance.mark("scene-editor:load:end");
      try {
        performance.measure("scene-editor:load", "scene-editor:load:start", "scene-editor:load:end");
      } catch {
        // older engines without measure window — marks alone are enough
      }
    }
  }

  getDocument(): SceneDocument {
    return this.#requireController().getDocument();
  }

  selectObject(id: string): void {
    this.#requireController().select([id]);
  }

  executeCommand(command: Parameters<EditorController["executeCommand"]>[0]): void {
    this.#requireController().executeCommand(command);
  }

  applyTransform(id: string, from: Transform, to: Transform): void {
    this.#requireController().applyTransform(id, from, to);
  }

  undo(): void {
    this.#requireController().undo();
  }

  redo(): void {
    this.#requireController().redo();
  }

  /** Authoritative save path (D18): hosts persist in response to this event. */
  requestSave(): void {
    this.dispatchEvent(new CustomEvent("save-request", { detail: { reason: "manual" } }));
  }

  #requireController(): EditorController {
    if (!this.#controller) {
      throw new SceneEditorError(SceneErrorCode.Lifecycle, "Editor not initialized");
    }
    return this.#controller;
  }

  #resetReady(): void {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  async #init(): Promise<void> {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    try {
      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      this.appendChild(canvas);
      const runtime = SceneEditorElement.runtimeFactory(canvas);
      const controller = new EditorController(runtime);
      this.#controller = controller;

      // resize seam: ThreeRuntime exposes resize(); FakeRuntime does not (optional).
      const maybeResize = runtime as { resize?: (w?: number, h?: number) => void };
      const applySize = (): void => {
        maybeResize?.resize?.(this.clientWidth, this.clientHeight);
      };
      applySize();
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(applySize);
        ro.observe(this);
        controller.disposers.add(() => ro.disconnect());
      }

      runtime.events.on(
        "selection-change",
        (payload) => {
          this.dispatchEvent(new CustomEvent("selection-change", { detail: payload }));
        },
        // signal support not on bus — manual off on disconnect via destroy of runtime
      );

      runtime.events.on("history-change", (payload) => {
        this.dispatchEvent(new CustomEvent("history-change", { detail: payload }));
        if (payload.dirty !== this.#lastDirty) {
          this.#lastDirty = payload.dirty;
          this.dispatchEvent(
            new CustomEvent("document-dirty", { detail: { dirty: payload.dirty } }),
          );
        }
      });

      this.addEventListener("keydown", this.#onKeyDown, { signal });

      this.dispatchEvent(new CustomEvent("scene-ready"));
      this.#resolveReady();
    } catch (err) {
      const se =
        err instanceof SceneEditorError
          ? err
          : new SceneEditorError(SceneErrorCode.Lifecycle, "Editor init failed", {
              cause: err,
            });
      this.#emitError(se.code, se.message, se.cause);
      this.#rejectReady(se);
    }
  }

  #onKeyDown = (event: Event): void => {
    const ke = event as KeyboardEvent;
    const controller = this.#controller;
    if (!controller) return;
    // Focus domain (D20): ignore keys unless focus is inside this element.
    const active = document.activeElement;
    if (active !== this && !this.contains(active)) return;
    const mod = ke.ctrlKey || ke.metaKey;
    const key = ke.key.toLowerCase();
    if (mod && key === "z" && !ke.shiftKey) {
      ke.preventDefault();
      controller.undo();
      return;
    }
    if ((mod && key === "z" && ke.shiftKey) || (mod && key === "y")) {
      ke.preventDefault();
      controller.redo();
      return;
    }
    // G/R/S tool modes: reserved for stage 2; swallowed so hosts can rely on capture list.
    if (!mod && (key === "g" || key === "r" || key === "s")) {
      ke.preventDefault();
    }
  };

  #emitError(code: string, message: string, cause?: unknown): void {
    const detail: { code: string; message: string; cause?: unknown } = { code, message };
    if (cause !== undefined) detail.cause = cause;
    this.dispatchEvent(new CustomEvent("error", { detail }));
  }
}
