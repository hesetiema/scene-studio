import { test, expect, type Page } from "@playwright/test";

/**
 * Real-browser visual regression (VR).
 *
 * Determinism rules:
 * - the `visual` Playwright project forces SwiftShader (software rasterization),
 * - only the `<scene-editor>` surface is captured; HUD/header/footer are hidden
 *   so font and layout differences between Windows, Linux and CI cannot leak in,
 * - the element is pinned to a fixed 1280×800 box so the camera aspect is stable.
 *
 * Update baselines after intentional visual changes:
 *   pnpm test:e2e:visual --update-snapshots
 */
const VIEWPORT = { width: 1280, height: 800 };

/** Hide host chrome and pin the editor to the viewport for a canvas-only shot. */
const ISOLATE_VIEWPORT_CSS = `
  .app-header, .app-footer, aside.panel, #toast, #drop-overlay, #welcome {
    display: none !important;
  }
  #viewport {
    position: fixed !important;
    inset: 0 !important;
    width: ${VIEWPORT.width}px !important;
    height: ${VIEWPORT.height}px !important;
    z-index: 2147483647 !important;
  }
`;

const SHOT_OPTIONS = {
  // Software rendering is deterministic; 1% absorbs minor AA differences while
  // still failing when a gizmo, object or material disappears.
  maxDiffPixelRatio: 0.01,
  animations: "disabled",
  // SwiftShader cold start plus the element's ResizeObserver can keep the canvas
  // "unstable" for longer than Playwright's 5 s default when workers run in
  // parallel; the first shot of a full run used to time out here.
  timeout: 15_000,
} as const;

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

async function isolateViewport(page: Page): Promise<void> {
  await page.addStyleTag({ content: ISOLATE_VIEWPORT_CSS });
  await page.waitForFunction(
    ({ width, height }) => {
      const el = document.querySelector("#viewport");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1;
    },
    VIEWPORT,
  );
  // Let the element's ResizeObserver resize the drawing buffer, then present.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

test.describe("visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test("initial scene: grid + boxes + asset gem", async ({ page }) => {
    await page.goto("/?scene=default&mode=editor");
    await waitForBoot(page);
    await isolateViewport(page);
    await expect(page.locator("#viewport")).toHaveScreenshot("initial-scene.png", SHOT_OPTIONS);
  });

  test("box-1 selected: transform gizmo visible", async ({ page }) => {
    await page.goto("/?select=box-1&mode=editor");
    await waitForBoot(page);
    await isolateViewport(page);
    await expect(page.locator("#viewport")).toHaveScreenshot("box1-selected.png", SHOT_OPTIONS);
  });

  test("box-1 transformed: moved + rotated + scaled", async ({ page }) => {
    await page.goto("/?select=box-1&mode=editor&move=1,0.5,0&rot=0,0.8,0&scale=1.2,1.2,1.2");
    await waitForBoot(page);
    await isolateViewport(page);
    await expect(page.locator("#viewport")).toHaveScreenshot("box1-transformed.png", SHOT_OPTIONS);
  });

  test("box-2 selected only (multi-object scene sanity)", async ({ page }) => {
    await page.goto("/?select=box-2&mode=editor");
    await waitForBoot(page);
    await isolateViewport(page);
    await expect(page.locator("#viewport")).toHaveScreenshot("box2-selected.png", SHOT_OPTIONS);
  });

  test("canvas non-blank smoke: composited frame has scene content", async ({ page }) => {
    await page.goto("/?scene=default&mode=editor");
    await waitForBoot(page);
    await isolateViewport(page);
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
