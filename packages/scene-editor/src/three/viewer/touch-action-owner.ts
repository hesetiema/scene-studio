/**
 * `touch-action` ownership for the viewer canvas.
 *
 * Both of three's addons that listen on the canvas claim the property when they
 * connect — `OrbitControls` ("Disable touch scroll") and `TransformControls`:
 *
 *   connect(element) { … this.domElement.style.touchAction = 'none' }
 *
 * Those connects do not happen when the viewer asks for them: the orbit addon
 * arrives from one dynamic import and the gizmo from another, so re-asserting
 * our value once after each mount is a race. It lost often enough to be visible
 * (the canvas read back `none` on roughly half of the loads, taking page scroll
 * with it), which is why the canvas is *watched* instead: whatever writes, our
 * value goes back.
 *
 * A single owner keeps this honest — the viewer has one requested value, and the
 * observer only ever restores that value.
 */

/** The slice of an element this needs; unit tests pass style-only stubs. */
export interface TouchActionTarget {
  style?: CSSStyleDeclaration;
  nodeType?: number;
}

export interface TouchActionOwner {
  /** Remember `value` and hold it, or `null` to stop owning the property. */
  set(value: string | null): void;
  /** Stop watching; the canvas keeps whatever it currently has. */
  dispose(): void;
}

export function createTouchActionOwner(dom: TouchActionTarget | undefined): TouchActionOwner {
  let value: string | null = null;
  let observer: MutationObserver | null = null;

  const apply = (): void => {
    if (value === null || !dom?.style) return;
    // Writing the same value would re-enter the observer for nothing.
    if (dom.style.touchAction === value) return;
    dom.style.touchAction = value;
  };

  const watch = (): void => {
    if (observer || typeof MutationObserver === "undefined" || !dom) return;
    // Only real elements can be observed; a `{ style }` stub cannot.
    if (typeof dom.nodeType !== "number") return;
    observer = new MutationObserver(() => apply());
    observer.observe(dom as unknown as Node, {
      attributes: true,
      attributeFilter: ["style"],
    });
  };

  return {
    set(next: string | null): void {
      value = next;
      if (value === null) return;
      watch();
      apply();
    },
    dispose(): void {
      observer?.disconnect();
      observer = null;
    },
  };
}
