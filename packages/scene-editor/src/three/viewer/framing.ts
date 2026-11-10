import * as THREE from "three";

/**
 * Vertex-exact framing measurement, mirroring model-viewer's `updateFraming()`.
 *
 * Why not the bounding box: a box is a *superset* of the mesh. Two models with
 * the same box diagonal can differ a lot in how much of the box they actually
 * occupy (a hollow helmet vs a solid crate), so a box fit is systematically
 * too far out. model-viewer measures the vertices themselves, then frames a
 * sphere around the target centre. Measured against it, a box fit landed
 * between 10% too small and 16% too small on the Khronos samples.
 *
 * The second metric is horizontal: model-viewer does **not** push the camera
 * back for a wide model, it widens the vertical FOV instead
 * (`adjustedFoV()`), so distance and vertical fill are untouched. Reproducing
 * that needs the same `radiusXZ / (distance - |y|)` maximum, which is only
 * meaningful once the distance is known — hence a second pass.
 */

/**
 * Upper bound on vertices visited per pass. A 500k-vertex CAD assembly should
 * not stall the first frame; sampling its vertices still lands the radius
 * within a fraction of a percent, because the extreme point of a dense mesh is
 * rarely a lone spike.
 */
const VERTEX_BUDGET = 500_000;

export interface FramingMetrics {
  /** Max distance from the target centre to any vertex (world space). */
  radius: number;
  /**
   * `max(radiusXZ / (distance - |y|))` over the same vertices — the tangent of
   * the horizontal half-angle the content needs from `distance` away.
   */
  horizontalTanAt(distance: number): number;
}

/** Per-vertex callback; the vector is reused, so copy anything you keep. */
function forEachVertex(
  roots: readonly THREE.Object3D[],
  visit: (vertex: THREE.Vector3) => void,
): void {
  const vertex = new THREE.Vector3();
  let budget = VERTEX_BUDGET;

  for (const root of roots) {
    if (budget <= 0) return;
    root.updateWorldMatrix(true, true);
    root.traverseVisible((child) => {
      if (budget <= 0) return;
      const mesh = child as THREE.Mesh & { isSkinnedMesh?: boolean };
      const position = mesh.geometry?.attributes?.position;
      if (!position) return;

      // Same traversal model-viewer uses: morph/bone-deformed vertices come from
      // `getVertexPosition`, and a skinned mesh's own matrix is skipped (glTF
      // skinning already lands in world space, and skinned roots are identity).
      const deformable = typeof mesh.getVertexPosition === "function";
      const stride = Math.max(1, Math.ceil(position.count / Math.max(budget, 1)));
      for (let i = 0; i < position.count; i += stride) {
        if (deformable) mesh.getVertexPosition(i, vertex);
        else vertex.fromBufferAttribute(position, i);
        if (mesh.isSkinnedMesh !== true) vertex.applyMatrix4(mesh.matrixWorld);
        visit(vertex);
      }
      budget -= Math.ceil(position.count / stride);
    });
  }
}

/** `undefined` when nothing visible carries geometry (placeholders, lights). */
export function measureFraming(
  roots: readonly THREE.Object3D[],
  center: THREE.Vector3,
): FramingMetrics | undefined {
  let radiusSq = 0;
  let sawVertex = false;
  forEachVertex(roots, (vertex) => {
    sawVertex = true;
    radiusSq = Math.max(radiusSq, center.distanceToSquared(vertex));
  });
  if (!sawVertex) return undefined;

  const radius = Math.sqrt(radiusSq);
  return {
    radius,
    horizontalTanAt(distance: number): number {
      let maxTan = 0;
      const safe = Math.max(distance, 1e-4);
      forEachVertex(roots, (vertex) => {
        const dx = vertex.x - center.x;
        const dz = vertex.z - center.z;
        const dy = Math.abs(vertex.y - center.y);
        const depth = safe - dy;
        // A vertex at or behind the camera plane cannot be framed by widening
        // the FOV; clamping keeps the result finite instead of flipping sign.
        if (depth <= 1e-4) {
          maxTan = Math.max(maxTan, Math.hypot(dx, dz) / 1e-4);
          return;
        }
        maxTan = Math.max(maxTan, Math.hypot(dx, dz) / depth);
      });
      return maxTan;
    },
  };
}
