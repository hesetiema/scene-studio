/**
 * EffectTool-style BIM outline / location parsing — pure, unit-agnostic.
 *
 * The SDK deliberately encodes no unit system and no axis convention beyond
 * what the *format* itself defines:
 * - `outline` is a planar polygon set: blocks → rings → points (`X`, `Y`).
 *   `outlineToShapes` scales it by a caller-supplied factor (default `1`) so the
 *   consumer decides whether that is millimetres, feet, or metres.
 * - `bimLocation` is a `"x,y,z"` triple; `parseBimLocation` returns the raw
 *   numbers. Mapping them into a three.js world (axis swap, unit scale) is a
 *   consumer policy — see the vent demo for one concrete mapping.
 */
import * as THREE from "three";

/** A single outline / location vertex (`cacheRwd/listModelViewFieldsByObjectId`). */
export interface OutlinePoint {
  X: number;
  Y: number;
  Z?: number;
}

/**
 * Outline JSON: blocks → rings → points.
 * Each block becomes one THREE.Shape (ring[0] = border, ring[1..] = holes).
 */
export type OutlineJson = OutlinePoint[][][];

/** Parse an outline field (JSON string or pre-parsed) into `OutlineJson`. */
export function parseOutline(outline: OutlineJson | string | undefined | null): OutlineJson | null {
  if (!outline) return null;
  if (typeof outline === "string") {
    try {
      return parseOutline(JSON.parse(outline) as OutlineJson);
    } catch {
      return null;
    }
  }
  return Array.isArray(outline) && outline.length > 0 ? outline : null;
}

/** `"x,y,z"` → raw `[x, y, z]`; `null` when missing or non-finite. */
export function parseBimLocation(bimLocation: string | undefined | null): [number, number, number] | null {
  if (!bimLocation) return null;
  const parts = bimLocation.split(",").map((p) => Number(p));
  const [px, py, pz] = parts;
  if (px === undefined || py === undefined || pz === undefined) return null;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  return [px, py, pz];
}

export interface OutlineToShapesOptions {
  /**
   * Planar scale applied to `X`/`Y` (and ignored for `Z`). Default `1`
   * (unit-agnostic). Pass e.g. a millimetre→world factor from the consumer.
   */
  scale?: number;
}

/**
 * Outline → THREE.Shape[] in outline-plan space (shape XY = point XY × scale).
 * Callers choose how the plan maps into their world; `extrudedOutlineGeometry`
 * offers the common "plan → XZ, extrusion → +Y" convention.
 */
export function outlineToShapes(
  outline: OutlineJson,
  options?: OutlineToShapesOptions,
): THREE.Shape[] {
  const scale = options?.scale ?? 1;
  const shapes: THREE.Shape[] = [];
  for (const block of outline) {
    if (!Array.isArray(block) || block.length === 0) continue;
    const border = block[0];
    if (!Array.isArray(border) || border.length < 3) continue;
    const shape = new THREE.Shape();
    for (let i = 0; i < border.length; i++) {
      const pt = border[i]!;
      const x = pt.X * scale;
      const y = pt.Y * scale;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    for (let h = 1; h < block.length; h++) {
      const ring = block[h]!;
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const hole = new THREE.Path();
      for (let j = 0; j < ring.length; j++) {
        const pt = ring[j]!;
        const x = pt.X * scale;
        const y = pt.Y * scale;
        if (j === 0) hole.moveTo(x, y);
        else hole.lineTo(x, y);
      }
      shape.holes.push(hole);
    }
    shape.autoClose = true;
    shapes.push(shape);
  }
  return shapes;
}
