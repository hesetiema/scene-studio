/** Every HUD owner is a mountable panel with a single destroy path. */
export interface Panel {
  mount(): void;
  destroy(): void;
}

/**
 * Shared DOM binding helpers. Panels collect their listeners here so a panel
 * never leaks a handler after `destroy()`.
 */
export abstract class BasePanel implements Panel {
  readonly #disposers: Array<() => void> = [];

  protected listen<E extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
  ): void {
    target.addEventListener(type, handler as EventListener);
    this.#disposers.push(() => target.removeEventListener(type, handler as EventListener));
  }

  protected click(selector: string, handler: () => void): void {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) this.listen(element, "click", handler);
  }

  protected syncActive(selector: string, active: boolean): void {
    document.querySelector(selector)?.classList.toggle("active", active);
  }

  protected syncText(selector: string, text: string): void {
    const element = document.querySelector(selector);
    if (element) element.textContent = text;
  }

  abstract mount(): void;

  destroy(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
  }
}
