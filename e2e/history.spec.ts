import { expect, test, type Page } from "@playwright/test";
import { openAdvanced } from "./support/ui";

/**
 * Unified undo/redo: viewer settings (valtio snapshot stack) and document
 * commands (SDK history) share one toolbar pair and one keyboard binding.
 *
 * 撤销/重做按钮常驻在面板标题栏（不随分组折叠），按钮本身无需展开；
 * 但曝光/环境光强度收在「灯光 → 更多设置」里，所以 boot 后统一展开一次。
 */

async function boot(page: Page): Promise<void> {
  await page.goto("/?scene=default");
  await page.waitForFunction(() => document.body.dataset.boot === "ready");
  // 曝光 / 环境光强度位于「灯光 → 更多设置」，本文件所有用例都要改它们。
  await openAdvanced(page, "group-lighting");
}

const readExposure = (page: Page) =>
  page.evaluate(() => (window as unknown as { __store: { state: { exposure: number } } }).__store.state.exposure);

const readBoxX = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __editor: { getDocument(): { objects: { id: string; position: number[] }[] } } })
        .__editor.getDocument()
        .objects.find((o) => o.id === "box-1")!.position[0],
  );

async function moveBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = (window as unknown as {
      __editor: {
        getDocument(): { objects: { id: string; position: number[]; rotation: number[]; scale: number[] }[] };
        applyTransform(
          id: string,
          from: { position: number[]; rotation: number[]; scale: number[] },
          to: { position: number[]; rotation: number[]; scale: number[] },
        ): void;
      };
    }).__editor;
    const from = el.getDocument().objects.find((o) => o.id === "box-1")!;
    el.applyTransform(
      "box-1",
      { position: from.position, rotation: from.rotation, scale: from.scale },
      {
        position: [from.position[0] + 2, from.position[1], from.position[2]],
        rotation: from.rotation,
        scale: from.scale,
      },
    );
  });
}

test("panel settings undo/redo through the toolbar", async ({ page }) => {
  await boot(page);

  await page.locator("#exposure-slider").fill("1.6");
  await expect.poll(() => readExposure(page)).toBe(1.6);

  await page.click("#btn-undo");
  await expect.poll(() => readExposure(page)).toBe(1);

  await page.click("#btn-redo");
  await expect.poll(() => readExposure(page)).toBe(1.6);
});

test("keyboard undo prefers the newest change across viewer and document", async ({ page }) => {
  await boot(page);

  const before = await readBoxX(page);
  await moveBox(page);
  await expect.poll(() => readBoxX(page)).toBeCloseTo(before + 2, 3);

  await page.locator("#exposure-slider").fill("1.4");
  await expect.poll(() => readExposure(page)).toBe(1.4);

  // 最新的是曝光 → 先撤设置
  await page.keyboard.press("Control+z");
  await expect.poll(() => readExposure(page)).toBe(1);
  await expect.poll(() => readBoxX(page)).toBeCloseTo(before + 2, 3);

  // 再撤文档命令
  await page.keyboard.press("Control+z");
  await expect.poll(() => readBoxX(page)).toBeCloseTo(before, 3);

  // 重做按撤销顺序回放
  await page.keyboard.press("Control+y");
  await expect.poll(() => readBoxX(page)).toBeCloseTo(before + 2, 3);
  await page.keyboard.press("Control+y");
  await expect.poll(() => readExposure(page)).toBe(1.4);
});

test("slider drags coalesce into one history entry", async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>("#ambient-scale")!;
    for (let value = 110; value <= 180; value += 10) {
      slider.value = String(value);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  const readScale = () =>
    page.evaluate(
      () => (window as unknown as { __store: { state: { ambientScale: number } } }).__store.state.ambientScale,
    );
  await expect.poll(readScale).toBeCloseTo(1.8, 3);

  // 一连串 input 合并成一步：撤销直接回到基线
  await page.click("#btn-undo");
  await expect.poll(readScale).toBe(1);
});

test("ctrl+z inside the viewport undoes once", async ({ page }) => {
  await boot(page);

  await page.locator("#exposure-slider").fill("1.8");
  await page.waitForTimeout(500);
  await page.locator("#exposure-slider").fill("0.6");
  await expect.poll(() => readExposure(page)).toBe(0.6);

  await page.locator("scene-editor").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => readExposure(page)).toBe(1.8);
});
