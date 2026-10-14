import type { RuntimeEventBus, RuntimeEventMap } from "./runtime-contract";

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
