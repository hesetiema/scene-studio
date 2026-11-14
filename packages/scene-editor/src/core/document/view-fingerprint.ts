import type { ViewState } from "./schema";

/**
 * Decimals kept when comparing two views.
 *
 * The runtime rebuilds the camera pose from its controls on every frame, so a
 * pose read back is not bit-identical to the one written: the same view comes
 * back as `3.4191101533476864` where the document holds `3.4191101533476878`
 * (~1e-15, i.e. pure double noise). Exact comparison would call that "moved" and
 * never let a restored pose clear `dirty`; 1e-6 is a micrometre in metre-scale
 * scenes, far below anything a gesture can express.
 */
const DECIMALS = 6;

/**
 * Stable serialization of a view, for equality comparison only.
 *
 * `JSON.stringify` is sensitive to key insertion order, and the same pose reaches
 * the controller through several paths that each build the object differently —
 * a runtime report, a host restoring one of its own snapshots, a document load.
 * Sorting keys makes "the same view" mean the same thing on all of them.
 *
 * The result is used to clear `dirty`, so every approximation has to fail closed:
 * a pose that differs by more than the quantum produces a different string and
 * simply stays dirty.
 */
export function viewFingerprint(view: ViewState): string {
  return JSON.stringify(canonicalize(view));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    // `toFixed` (unlike `v * 10 ** n`) stays exact for large magnitudes.
    return Number(value.toFixed(DECIMALS));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      // An absent optional field and an explicitly-undefined one are the same view.
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}
