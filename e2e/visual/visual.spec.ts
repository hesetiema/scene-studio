import { test, expect, type Page } from "@playwright/test";

/**
 * Real-browser visual regression (VR).
 * WebGL anti-aliasing / GPU variance: allow a small pixel ratio diff.
 * Baselines live next to this file under visual/.
 *
 * Update baselines after intentional visual changes:
 *   pnpm test:e2e:visual --update-snapshots
 */
const VIEWPORT = { width: 1280, height: 800 };

async function waitForBoot(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.boot === "ready", null, {
    timeout: 20_000,
  });
  // gizmo (TransformControls) may still be mounting after boot flag in some paths
  await page.evaluate(async () => {
    const el = document.querySelector("scene-editor") as unknown as {
      controlsReady?: Promise<void>;
    };
    if (el?.controlsReady) await el.controlsReady;
  });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

test.describe("visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test("initial scene: grid + boxes + asset gem", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await expect(page).toHaveScreenshot("initial-scene.png", {
      maxDiffPixelRatio: 0.03,
      animations: "disabled",
    });
  });

  test("box-1 selected: transform gizmo visible", async ({ page }) => {
    await page.goto("/?select=box-1");
    await waitForBoot(page);
    await expect(page).toHaveScreenshot("box1-selected.png", {
      maxDiffPixelRatio: 0.03,
      animations: "disabled",
    });
  });

  test("box-1 transformed: moved + rotated + scaled", async ({ page }) => {
    await page.goto("/?select=box-1&move=1,0.5,0&rot=0,0.8,0&scale=1.2,1.2,1.2");
    await waitForBoot(page);
    await expect(page).toHaveScreenshot("box1-transformed.png", {
      maxDiffPixelRatio: 0.03,
      animations: "disabled",
    });
  });

  test("box-2 selected only (multi-object scene sanity)", async ({ page }) => {
    await page.goto("/?select=box-2");
    await waitForBoot(page);
    await expect(page).toHaveScreenshot("box2-selected.png", {
      maxDiffPixelRatio: 0.03,
      animations: "disabled",
    });
  });

  test("canvas non-blank smoke: composited frame has scene content", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // Capture the composited canvas (WebGL buffer itself is cleared after present).
    const png = await page.locator("scene-editor canvas").screenshot();
    // PNG should not be a tiny uniform buffer — a blank canvas compresses very small.
    // Two lit boxes + grid over black produce a reasonably complex PNG.
    expect(png.byteLength).toBeGreaterThan(5_000);
    // Also verify document actually reports loaded objects
    const count = await page.evaluate(
      () => window.__editor.getDocument().objects.length,
    );
    expect(count).toBe(3); // box-1, box-2, gem-1 (assetId)
  });
});
