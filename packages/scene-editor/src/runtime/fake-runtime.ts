import type { SceneDocument } from "../core/document/schema";
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
  };
  pickResult: string | null = null;

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
}
