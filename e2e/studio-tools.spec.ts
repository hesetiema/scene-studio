import { expect, test, type Page } from "@playwright/test";
import { openAdvanced, openGroup } from "./support/ui";

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
  await openGroup(page, "group-transform");

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
  await openGroup(page, "group-model");

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

test("animation panel lists clips, auto-plays, and toggles transport", async ({ page }) => {
  await boot(page);
  await openGroup(page, "group-animation");
  await openAdvanced(page, "group-animation");

  await page.selectOption("#model-select", "fox");
  await expect.poll(() => page.textContent("#anim-count")).toBe("3");
  // A freshly loaded asset with clips auto-plays clip #0 (viewer convention).
  await expect(page.locator("#anim-play")).toHaveText("暂停");

  await page.click("#anim-play");
  await expect(page.locator("#anim-play")).toHaveText("播放");
  await page.click("#anim-play");
  await expect(page.locator("#anim-play")).toHaveText("暂停");

  await page.locator("#anim-speed").fill("1.5");
  await expect(page.locator("#anim-speed-val")).toHaveText("1.50x");

  await page.selectOption("#anim-select", { index: 1 });
  await expect(page.locator("#anim-play")).toHaveText("暂停");
});

test("material panel applies to the selection and restores originals", async ({ page }) => {
  await boot(page);

  await page.evaluate(
    () => (window as unknown as { __editor: { selectObject(id: string): void } }).__editor.selectObject("box-1"),
  );
  await expect(page.locator("#material-hint")).toHaveText(/已选中 \d+ 个网格/);

  /** 材质是运行时预览，读渲染对象即可，不应出现在文档里。 */
  const readOpacity = () =>
    page.evaluate(() => {
      const runtime = (window as unknown as { __runtime: RuntimeHook }).__runtime;
      let opacity = 1;
      (runtime as unknown as { getObjectById(id: string): { traverse(fn: (n: unknown) => void): void } })
        .getObjectById("box-1")
        .traverse((node) => {
          const mesh = node as { isMesh?: boolean; material?: { opacity: number } | { opacity: number }[] };
          if (mesh.isMesh !== true) return;
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (material) opacity = material.opacity;
        });
      return opacity;
    });

  expect(await readOpacity()).toBe(1);

  await page.locator("#material-opacity").fill("40");
  await expect.poll(readOpacity).toBeCloseTo(0.4, 2);

  await page.click("#btn-material-reset");
  await expect.poll(readOpacity).toBe(1);
});

test("lighting controls tune intensity and optionally follow the camera", async ({ page }) => {
  await boot(page);
  await openAdvanced(page, "group-lighting");

  const readAmbient = () =>
    page.evaluate(() => {
      const runtime = (window as unknown as { __runtime: { scene: { children: unknown[] } } })
        .__runtime;
      const light = runtime.scene.children.find(
        (child) => (child as { isAmbientLight?: boolean }).isAmbientLight,
      ) as { intensity: number };
      return light.intensity;
    });

  // studio 预设环境光 0.65 → 200% = 1.3
  await page.locator("#ambient-scale").fill("200");
  await expect.poll(readAmbient).toBeCloseTo(1.3, 3);

  await page.check("#follow-camera");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const runtime = (window as unknown as {
          __runtime: { scene: { children: unknown[] }; camera: { position: unknown } };
        }).__runtime;
        const light = runtime.scene.children.find(
          (child) => (child as { isDirectionalLight?: boolean }).isDirectionalLight,
        ) as { position: { x: number; y: number; z: number } };
        const camera = runtime.camera.position as { x: number; y: number; z: number };
        return [
          +(light.position.x - camera.x).toFixed(3),
          +(light.position.y - camera.y).toFixed(3),
          +(light.position.z - camera.z).toFixed(3),
        ];
      }),
    )
    .toEqual([0, 0, 0]);
});

test("snapshot and GLB export produce downloads", async ({ page }) => {
  await boot(page);
  await openGroup(page, "group-files");

  const snapshot = page.waitForEvent("download");
  await page.click("#btn-snapshot");
  expect((await snapshot).suggestedFilename()).toMatch(/\.png$/);

  const glb = page.waitForEvent("download");
  await page.click("#btn-export-glb");
  expect((await glb).suggestedFilename()).toMatch(/\.glb$/);
});
