import type { SceneDocument } from "../core/document/schema";
import type {
  RuntimeContract,
  RuntimeEventBus,
  RuntimeEventMap,
  Transform,
} from "./runtime-contract";

export class TypedEventBus implements RuntimeEventBus {
  #handlers = new Map<keyof RuntimeEventMap, Set<(payload: never) => void>>();

  on<K extends keyof RuntimeEventMap>(
    type: K,
    handler: (payload: RuntimeEventMap[K]) => void,
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

  emit<K extends keyof RuntimeEventMap>(type: K, payload: RuntimeEventMap[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      (handler as (p: RuntimeEventMap[K]) => void)(payload);
    }
  }
}

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
