import type { Transform } from "../../runtime/runtime-contract";

/** Structural slice of three's TransformControls (D14/D15 addon isolation). */
export interface TransformControlsLike {
  addEventListener(type: string, listener: () => void): void;
  dispose(): void;
  attach(object: unknown): void;
  detach(): void;
  getHelper?(): unknown;
}

export interface TransformControlsAdapterOptions {
  controls: TransformControlsLike;
  /** Called on drag start; return the from-snapshot for the command. */
  onStart: () => Transform;
  /** Called once per completed drag with the from-snapshot (one drag = one command, D15). */
  onCommit: (from: Transform) => void;
}

export interface TransformControlsAdapter {
  dispose(): void;
}

/**
 * Wraps three's TransformControls behind our addon seam (D14).
 * Drag lifecycle: mouseDown captures from; mouseUp commits exactly once.
 */
export function createTransformControlsAdapter(
  options: TransformControlsAdapterOptions,
): TransformControlsAdapter {
  let pendingFrom: Transform | null = null;

  const handleDown = (): void => {
    pendingFrom = options.onStart();
  };
  const handleUp = (): void => {
    if (!pendingFrom) return;
    const from = pendingFrom;
    pendingFrom = null;
    options.onCommit(from);
  };

  options.controls.addEventListener("mouseDown", handleDown);
  options.controls.addEventListener("mouseUp", handleUp);

  return {
    dispose(): void {
      options.controls.dispose();
    },
  };
}
