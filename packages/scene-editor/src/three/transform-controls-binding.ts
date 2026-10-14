import type { Object3D, Vector3 } from "three";

export interface TransformSnapshot {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** Minimal structural interface for THREE.TransformControls (D15 adapter). */
export interface TransformControlsLike {
  addEventListener(type: string, listener: (event: { object?: Object3D | unknown }) => void): void;
  removeEventListener?(type: string, listener?: (event: { object?: Object3D | unknown }) => void): void;
  attach(object: Object3D): void;
  detach(): void;
}

export interface TransformControlsBindingOptions {
  controls: TransformControlsLike;
  /** Returns the currently selected Object3D (or null). */
  getSelectedObject: () => Object3D | null;
  /** Called once per completed drag with { from, to }. */
  onTransform: (t: { from: TransformSnapshot; to: TransformSnapshot }) => void;
}

export interface TransformControlsBinding {
  /** Call when the attached object is replaced (re-read from position). */
  updateSelectedObject(obj: Object3D | null): void;
  attach(obj: Object3D): void;
  detach(): void;
  dispose(): void;
}

function snapshot(obj: Object3D | { position: Vector3 }): TransformSnapshot {
  const p = (obj as Object3D).position;
  const r = (obj as Object3D).rotation;
  const s = (obj as Object3D).scale;
  return {
    position: [p.x, p.y, p.z],
    rotation: r ? [r.x, r.y, r.z] : [0, 0, 0],
    scale: s ? [s.x, s.y, s.z] : [1, 1, 1],
  };
}

/**
 * TransformControls adapter (D15): one continuous drag → exactly one
 * Transform (from@mouseDown, to@mouseUp). mouseUp without mouseDown is ignored.
 */
export function createTransformControlsBinding(
  options: TransformControlsBindingOptions,
): TransformControlsBinding {
  const { controls, getSelectedObject, onTransform } = options;
  let selected: Object3D | null = null;
  let from: TransformSnapshot | null = null;

  const onMouseDown = (): void => {
    const obj = selected ?? getSelectedObject();
    if (!obj) {
      from = null;
      return;
    }
    from = snapshot(obj);
  };

  const onMouseUp = (): void => {
    if (!from) return;
    const obj = selected ?? getSelectedObject();
    if (!obj) {
      from = null;
      return;
    }
    const to = snapshot(obj);
    const start = from;
    from = null;
    onTransform({ from: start, to });
  };

  controls.addEventListener("mouseDown", onMouseDown);
  controls.addEventListener("mouseUp", onMouseUp);

  return {
    updateSelectedObject(obj: Object3D | null): void {
      selected = obj;
    },
    attach(obj: Object3D): void {
      selected = obj;
      controls.attach(obj);
    },
    detach(): void {
      selected = null;
      from = null;
      controls.detach();
    },
    dispose(): void {
      selected = null;
      from = null;
      controls.removeEventListener?.("mouseDown", onMouseDown);
      controls.removeEventListener?.("mouseUp", onMouseUp);
    },
  };
}
