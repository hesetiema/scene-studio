import type { ViewState } from "../core/document/schema";

/**
 * Pure conversions between attribute syntax and scene numbers.
 *
 * Nothing here touches the runtime, the DOM beyond `getAttribute`, or module
 * state — every function is a pure mapping from a string (or a few numbers) to
 * a value the camera attribute layer and the hotspot layer both consume. It is
 * the bottom of `element/`: `viewer-attributes` and `slot-chrome` import from
 * here, never the other way round.
 */

/** `<scene-editor mode="viewer">` orbit triple axes, in attribute order. */
export const ORBIT_AXES = ["theta", "phi", "radius"] as const;

const DEG = Math.PI / 180;
/** Keeps the eye off the pole: `lookAt` is undefined when the offset is vertical. */
const PHI_EPSILON = 0.5;

/** The camera half of a view state, as the runtime and rig hand it around. */
export type CameraView = ViewState["camera"];

/** model-viewer's orbit triple: azimuth / polar / distance, degrees + world units. */
export interface CameraOrbit {
  /** Azimuth, degrees, measured from +Z toward +X (0 = looking from the front). */
  theta: number;
  /** Polar angle from +Y, degrees (75 = 15° above the horizon). */
  phi: number;
  /** Distance from the orbit target, world units. */
  radius: number;
}

/**
 * `"1 2 3"` → tuple, or `null` when the attribute is unusable.
 *
 * One format serves three attributes — hotspot `data-position` / `data-normal`
 * and the camera's `camera-target` — which is why this lives in the shared math
 * layer rather than next to either consumer: it is the parser for a `data-*`
 * vector attribute, and both the hotspot anchors and the camera pose read one.
 */
export function parseVector3(raw: string | null): [number, number, number] | null {
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 3) return null;
  const values = parts.map((part) => Number.parseFloat(part));
  if (values.some((value) => !Number.isFinite(value))) return null;
  return [values[0] as number, values[1] as number, values[2] as number];
}

/** model-viewer's `auto` placeholder, `90deg`, `1.2rad`, or a bare number. */
export function parseOrbitToken(
  raw: string | undefined,
  axis: (typeof ORBIT_AXES)[number],
): number | undefined {
  if (raw === undefined) return undefined;
  const token = raw.trim().toLowerCase();
  if (token === "" || token === "auto") return undefined;
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) return undefined;
  if (axis === "radius") return value;
  // Angles: `rad` converts, `deg` and unitless are already degrees.
  return token.endsWith("rad") ? (value * 180) / Math.PI : value;
}

/** `field-of-view="30deg"` → degrees; `auto` / garbage → undefined. */
export function parseAngle(raw: string | undefined): number | undefined {
  return parseOrbitToken(raw, "theta");
}

/**
 * Camera offset → orbit angles. `null` when the eye sits on the target (no
 * direction to speak of), so callers fall back instead of emitting `NaN`.
 *
 * The convention matches `min-camera-orbit` / `max-camera-orbit`: `theta` is the
 * azimuth from +Z toward +X and `phi` the polar angle from +Y — the same frame
 * model-viewer's `camera-orbit` uses, hence the same numbers a host can paste
 * between the two elements.
 */
export function orbitFromCamera(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): CameraOrbit | null {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(radius) || radius < 1e-6) return null;
  const phi = Math.acos(Math.min(Math.max(dy / radius, -1), 1)) / DEG;
  // atan2(x, z): 0° on +Z, +90° on +X.
  const theta = Math.atan2(dx, dz) / DEG;
  return { theta, phi, radius };
}

/** Orbit angles → camera offset from the target. */
export function cameraFromOrbit(
  target: readonly [number, number, number],
  orbit: CameraOrbit,
): [number, number, number] {
  const phi = Math.min(Math.max(orbit.phi, PHI_EPSILON), 180 - PHI_EPSILON) * DEG;
  const theta = orbit.theta * DEG;
  const radius = Math.max(orbit.radius, 1e-6);
  const horizontal = radius * Math.sin(phi);
  return [
    target[0] + horizontal * Math.sin(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + horizontal * Math.cos(theta),
  ];
}
