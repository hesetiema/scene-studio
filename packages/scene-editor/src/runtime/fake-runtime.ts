import type { SceneDocument, ViewState } from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type {
  RuntimeContract,
  RuntimeEventMap,
  Transform,
} from "./runtime-contract";
import { TypedEventBus } from "./typed-event-bus";

/** Test double implementing RuntimeContract; records every call (D5). */
export class FakeRuntime implements RuntimeContract {
  readonly events = new TypedEventBus();
  readonly calls = {
    loadDocument: [] as SceneDocument[],
    applyTransform: [] as Array<{ id: string; transform: Transform }>,
    clearSelection: 0,
    select: [] as string[][],
    pick: [] as Array<[number, number]>,
    flushDisposers: 0,
    applyViewState: [] as ViewState[],
  };
  pickResult: string | null = null;
  /** When true, applyViewState re-emits view-change (contract-violation probe). */
  viewChangeOnApply = false;
  #view: ViewState = createDefaultViewState();

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.calls.loadDocument.push(doc);
  }

  applyTransform(id: string, transform: Transform): void {
    this.calls.applyTransform.push({ id, transform });
  }

  clearSelection(): void {
    this.calls.clearSelection += 1;
  }

  select(ids: string[]): void {
    this.calls.select.push([...ids]);
  }

  pick(clientX: number, clientY: number): string | null {
    this.calls.pick.push([clientX, clientY]);
    return this.pickResult;
  }

  flushDisposers(): void {
    this.calls.flushDisposers += 1;
  }

  getViewState(): ViewState {
    return structuredClone(this.#view);
  }

  applyViewState(view: ViewState): void {
    this.calls.applyViewState.push(structuredClone(view));
    this.#view = structuredClone(view);
    if (this.viewChangeOnApply) this.events.emit("view-change", { view: this.getViewState() });
  }

  /** Test helper: pretend the user moved the camera. */
  simulateViewChange(view: ViewState): void {
    this.#view = structuredClone(view);
    const payload: RuntimeEventMap["view-change"] = { view: this.getViewState() };
    this.events.emit("view-change", payload);
  }
}
