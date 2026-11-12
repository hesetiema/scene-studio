/**
 * Outline → extruded geometry. Pure geometry only: no materials, no colours,
 * no elevations — the consumer owns every visual decision and places the mesh.
 *
 * The one convention baked in is the outline format's own: points live in a
 * plan (`X`,`Y`), so the extrusion is built in shape space and rotated −90°
 * about X, landing plan → world XZ and depth → world +Y. Pass `rotateToYUp:
 * false` to keep raw shape space (plan XY, depth +Z).
 */
import * as THREE from "three";
import { outlineToShapes, parseOutline, type OutlineJson } from "./bim-units";

export interface ExtrudedOutlineOptions {
  /** Extrusion depth in the consumer's world unit. */
  depth: number;
  /** Planar scale for outline `X`/`Y` (default `1`). */
  scale?: number;
  /** Rotate shape space so plan → world XZ and depth → +Y (default `true`). */
  rotateToYUp?: boolean;
}

/**
 * Build extruded geometry from a raw outline field (JSON string or parsed).
 * Returns `null` when the outline is missing/degenerate.
 */
export function extrudedOutlineGeometry(
  outline: OutlineJson | string | undefined | null,
  options: ExtrudedOutlineOptions,
): THREE.ExtrudeGeometry | null {
  const parsed = parseOutline(outline);
  if (!parsed) return null;
  const shapes = outlineToShapes(parsed, { scale: options.scale ?? 1 });
  if (shapes.length === 0) return null;

  const geometry = new THREE.ExtrudeGeometry(shapes, {
    steps: 1,
    depth: Math.max(options.depth, 0.001),
    bevelEnabled: false,
  });
  if (options.rotateToYUp !== false) {
    geometry.applyMatrix4(
      new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    );
  }
  return geometry;
}

export interface OutlinePlaneOptions {
  /** Planar scale for outline `X`/`Y` (default `1`). */
  scale?: number;
  /** Rotate shape space so plan → world XZ (default `true`). */
  rotateToYUp?: boolean;
}

/**
 * Build a **flat** (single-layer) geometry from a raw outline field.
 *
 * Use this instead of a near-zero extrusion for plan views: a 0.01-unit
 * extrusion puts two coplanar layers closer than the depth buffer can resolve
 * at plan-view camera distances, which shows up as alternating stripes. A
 * triangulated plane has one layer, so it cannot z-fight with itself.
 *
 * Returns `null` when the outline is missing/degenerate.
 */
export function outlinePlaneGeometry(
  outline: OutlineJson | string | undefined | null,
  options: OutlinePlaneOptions = {},
): THREE.ShapeGeometry | null {
  const parsed = parseOutline(outline);
  if (!parsed) return null;
  const shapes = outlineToShapes(parsed, { scale: options.scale ?? 1 });
  if (shapes.length === 0) return null;
  const geometry = new THREE.ShapeGeometry(shapes);
  if (options.rotateToYUp !== false) {
    geometry.applyMatrix4(
      new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    );
  }
  return geometry;
}

/** Planar centre of an outline (first ring vertices averaged), in raw units. */export function outlinePlanCentroid(
  outline: OutlineJson | string | undefined | null,
): [number, number] | null {
  const parsed = parseOutline(outline);
  if (!parsed) return null;
  let ax = 0;
  let ay = 0;
  let n = 0;
  for (const block of parsed) {
    for (const pt of block[0] ?? []) {
      ax += pt.X;
      ay += pt.Y;
      n++;
    }
  }
  return n > 0 ? [ax / n, ay / n] : null;
}
