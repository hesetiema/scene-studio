export class DisposerStack {
  #stack: Array<() => void> = [];

  add(disposer: () => void): void {
    this.#stack.push(disposer);
  }

  get size(): number {
    return this.#stack.length;
  }

  /** Run all disposers LIFO; empty the stack; rethrow first error (or AggregateError). */
  flush(): void {
    const items = this.#stack.splice(0).reverse();
    const errors: unknown[] = [];
    for (const dispose of items) {
      try {
        dispose();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Disposer flush failed");
    }
  }
}
