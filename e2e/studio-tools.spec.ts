import { expect, test, type Page } from "@playwright/test";

/**
 * Playground chrome regressions.
 *
 * These cover the wiring that lives above the SDK: gizmo tool switching, the
 * explode preview (must stay out of the document), and export/downloads.
 */

type RuntimeHook = {
  transformMode: string;
  getObjectById(id: string): { position: { x: number; y: number; z: number } } | undefined;
};

type EditorHook = {
  getDocument(): { objects: Array<{ id: string; position: number[] }> };
};

async function boot(page: Page): Promise<void> {
  await page.goto("/?scene=default");
  await page.waitForFunction(() => document.body.dataset.boot === "ready");
}

test("gizmo toolbar switches the transform tool", async ({ page }) => {
  await boot(page);

  await page.click("#gizmo-r");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __runtime: RuntimeHook }).__runtime.transformMode))
    .toBe("rotate");

  await page.click("#gizmo-s");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __runtime: RuntimeHook }).__runtime.transformMode))
    .toBe("scale");

  // Pointer mode clears the selection instead of leaving a dangling gizmo.
  await page.evaluate(() => (window as unknown as { __editor: { selectObject(id: string): void } }).__editor.selectObject("box-1"));
  await page.click("#gizmo-none");
  await expect
    .poll(() => page.evaluate(() => [...(window as unknown as { __editor: { selectedIds: readonly string[] } }).__editor.selectedIds]))
    .toEqual([]);
});

test("explode slider is a preview: object moves, document does not", async ({ page }) => {
  await boot(page);

  const readPositions = () =>
    page.evaluate(() => {
      const runtime = (window as unknown as { __runtime: RuntimeHook }).__runtime;
      const editor = (window as unknown as { __editor: EditorHook }).__editor;
      const live = runtime.getObjectById("box-1")!.position;
      const stored = editor.getDocument().objects.find((o) => o.id === "box-1")!.position;
      return { live: [live.x, live.y, live.z], stored };
    });

  const before = await readPositions();
  expect(before.live).toEqual(before.stored);

  await page.locator("#explode-slider").fill("80");
  await expect
    .poll(async () => {
      const { live, stored } = await readPositions();
      return Math.hypot(live[0]! - stored[0]!, live[1]! - stored[1]!, live[2]! - stored[2]!);
    })
    .toBeGreaterThan(0.1);

  await page.locator("#explode-slider").fill("0");
  await expect.poll(async () => (await readPositions()).live).toEqual(before.live);
});

test("snapshot and GLB export produce downloads", async ({ page }) => {
  await boot(page);

  const snapshot = page.waitForEvent("download");
  await page.click("#btn-snapshot");
  expect((await snapshot).suggestedFilename()).toMatch(/\.png$/);

  const glb = page.waitForEvent("download");
  await page.click("#btn-export-glb");
  expect((await glb).suggestedFilename()).toMatch(/\.glb$/);
});
