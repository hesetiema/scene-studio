import { test, expect, type Page } from "@playwright/test";

/**
 * Draw-call batching gate.
 *
 * `perf.html?instancing=0` runs the same scene without batching, so the two
 * runs differ in exactly one thing: whether repeated primitives share an
 * `InstancedMesh`. Frame times are *not* asserted here (SwiftShader is not a
 * real GPU — that is `perf.spec.ts`'s job); draw-call and triangle counts are
 * deterministic, which is what makes them a good regression gate.
 *
 * The close-up pass guards the *other* half of the deal: batching must not cost
 * frustum culling. One `InstancedMesh` per scene would report every instance's
 * triangles no matter where the camera looks; chunked batches report only what
 * is on screen.
 */

interface Report {
  status: string;
  objectCount: number;
  instancing: boolean;
  infoAfterLoad: { drawCalls: number; triangles: number } | null;
  /** Same scene, camera at the far corner: chunked batches must still cull. */
  infoCloseup: { drawCalls: number; triangles: number } | null;
  unload: {
    sceneChildrenAfter: number;
    sceneChildrenBaseline: number;
    objectsGone: boolean;
  } | null;
  errors: string[];
}

/** 5 000 boxes: enough chunks (20) for the close-up pass to mean something. */
const OBJECTS = 5000;
/** `BoxGeometry(1, 1, 1)` — the bench's only geometry. */
const TRIANGLES_PER_BOX = 12;

async function bench(page: Page, instancing: boolean): Promise<Report> {
  await page.goto(`/perf.html?objects=${OBJECTS}&frames=20&instancing=${instancing ? 1 : 0}`);
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __perfBench?: { report: { status: string } } }).__perfBench;
      return api != null && (api.report.status === "ready" || api.report.status === "failed");
    },
    undefined,
    { timeout: 120_000 },
  );
  // Phase two: teardown counters are filled by `finish()`, not by the bench.
  await page.evaluate(() => {
    void (window as unknown as { __perfBench: { finish: () => Promise<void> } }).__perfBench.finish();
  });
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __perfBench?: { report: { status: string } } }).__perfBench;
      return api != null && (api.report.status === "done" || api.report.status === "failed");
    },
    undefined,
    { timeout: 60_000 },
  );
  return (await page.evaluate(
    () => (window as unknown as { __perfBench: { report: Report } }).__perfBench.report,
  )) as Report;
}

test("repeated primitives collapse into one instanced draw", async ({ page }) => {
  const batched = await bench(page, true);
  const plain = await bench(page, false);

  expect(batched.errors).toEqual([]);
  expect(plain.errors).toEqual([]);

  // One draw per box without batching (minus what the wide camera culls); a
  // couple of dozen for 20 chunks with it.
  expect(plain.infoAfterLoad!.drawCalls).toBeGreaterThan(900);
  expect(batched.infoAfterLoad!.drawCalls).toBeLessThan(40);

  // Close-up through a narrow lens at one grid corner: chunked batches submit a
  // fraction of the scene, a single batch would submit all of it. Measured 18 432
  // of 60 000 triangles — the budget leaves room for a wider viewport.
  const sceneTriangles = OBJECTS * TRIANGLES_PER_BOX;
  const closeTris = batched.infoCloseup!.triangles;
  expect(closeTris).toBeGreaterThan(0);
  expect(closeTris).toBeLessThanOrEqual(sceneTriangles * 0.4);
  // …and it is still batching: a handful of draw calls for the whole patch.
  expect(batched.infoCloseup!.drawCalls).toBeLessThan(40);

  // Batching is a draw-time detail: the document still has all its objects, and
  // teardown still leaves no document object (or batch clone) behind.
  expect(batched.objectCount).toBe(OBJECTS);
  expect(batched.unload!.objectsGone).toBe(true);
  expect(batched.unload!.sceneChildrenAfter).toBeLessThanOrEqual(
    batched.unload!.sceneChildrenBaseline,
  );
});
