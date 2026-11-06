import type {
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type {
  RuntimeContract,
  RuntimeEventMap,
  ToneMappingMode,
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
    autoFrame: 0,
    setToneMapping: [] as ToneMappingMode[],
    setExposure: [] as number[],
    addObject: [] as SceneObjectDTO[],
    removeObject: [] as string[],
    reparent: [] as Array<{ id: string; parentId: string | undefined }>,
    setMaterial: [] as Array<{ id: string; material: MaterialDTO | undefined }>,
  };
  pickResult: string | null = null;
  /** When true, applyViewState re-emits view-change (contract-violation probe). */
  viewChangeOnApply = false;
  #view: ViewState = createDefaultViewState();
  #liveViewEvents = false;

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.calls.loadDocument.push(doc);
    // Mirrors ThreeRuntime: one progress ramp per load, then a `load` edge.
    this.events.emit("load-progress", { totalProgress: 0, reason: "model-load" });
    this.events.emit("load-progress", { totalProgress: 1, reason: "model-load" });
    this.events.emit("load", { sceneId: doc.sceneId });
  }

  applyTransform(id: string, transform: Transform): void {
    this.calls.applyTransform.push({ id, transform });
  }

  addObject(dto: SceneObjectDTO): void {
    this.calls.addObject.push(structuredClone(dto));
  }

  removeObject(id: string): void {
    this.calls.removeObject.push(id);
  }

  reparent(id: string, parentId: string | undefined): void {
    this.calls.reparent.push({ id, parentId });
  }

  setMaterial(id: string, material: MaterialDTO | undefined): void {
    this.calls.setMaterial.push({
      id,
      material: material === undefined ? undefined : structuredClone(material),
    });
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

  /** Live sampling is opt-in, mirroring ThreeRuntime. */
  setLiveViewEvents(enabled: boolean): void {
    this.#liveViewEvents = enabled;
  }

  autoFrame(): void {
    this.calls.autoFrame += 1;
  }

  setToneMapping(mode: ToneMappingMode): void {
    this.calls.setToneMapping.push(mode);
  }

  setExposure(value: number): void {
    this.calls.setExposure.push(value);
  }

  get liveViewEvents(): boolean {
    return this.#liveViewEvents;
  }

  /** Test helper: in-flight sample; a no-op unless live sampling is enabled. */
  simulateViewChanging(view: ViewState): void {
    if (!this.#liveViewEvents) return;
    this.#view = structuredClone(view);
    const payload: RuntimeEventMap["view-changing"] = { view: this.getViewState() };
    this.events.emit("view-changing", payload);
  }
}
