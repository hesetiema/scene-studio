export class SelectionManager {
  #ids: readonly string[] = [];

  constructor(private readonly onChange?: (ids: readonly string[]) => void) {}

  get ids(): readonly string[] {
    return this.#ids;
  }

  isSelected(id: string): boolean {
    return this.#ids.includes(id);
  }

  set(ids: string[]): void {
    const next = Object.freeze([...new Set(ids)]);
    if (next.length === this.#ids.length && next.every((id, i) => id === this.#ids[i])) {
      return;
    }
    this.#ids = next;
    this.onChange?.(this.#ids);
  }

  clear(): void {
    this.set([]);
  }
}
