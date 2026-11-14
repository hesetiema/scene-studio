import { expect, test, type Page } from "@playwright/test";

/**
 * `KHR_materials_variants` through the studio, measured on pixels.
 *
 * The bug this guards: rendering is on demand, so swapping a material slot has
 * to ask for a frame. Without that request the canvas kept the *previous*
 * variant's pixels until the camera next moved — the switch looked like it did
 * nothing, and a quick A→B→C sequence showed whichever pick happened to be
 * painted last. `mesh.material` was right the whole time, which is exactly why
 * this has to look at the frame.
 *
 * Colours are compared as the crop's mean RGB rather than byte-for-byte: two
 * materials of the same colourway legitimately produce different pixels (the
 * parser hands out its own material instance), and `damaged-helmet`-style assets
 * are not the target here — the shoe's three colourways are far apart.
 */

const MODEL = "/?mode=editor&model=variants-shoe";

/** Screenshot of a centre window of the canvas — no panel, no footer. */
async function canvasShot(page: Page): Promise<Buffer> {
  const box = await page.evaluate(() => {
    const canvas = document.querySelector("scene-editor")?.querySelector("canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!box) throw new Error("no canvas");
  const width = Math.round(box.width * 0.5);
  const height = Math.round(box.height * 0.6);
  return page.screenshot({
    clip: {
      x: Math.round(box.x + (box.width - width) / 2),
      y: Math.round(box.y + (box.height - height) / 2),
      width,
      height,
    },
  });
}

/** Mean RGB of a PNG, decoded by the browser itself (no image dep in the repo). */
async function meanColor(page: Page, shot: Buffer): Promise<[number, number, number]> {
  return page.evaluate(async (base64) => {
    const binary = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([binary], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const pixels = data.length / 4;
    return [r / pixels, g / pixels, b / pixels] as [number, number, number];
  }, shot.toString("base64"));
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test("variant switch repaints immediately and is order-independent", async ({ page }) => {
  test.setTimeout(120_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(MODEL);
  await page.waitForFunction(
    () => {
      const el = document.querySelector("scene-editor") as HTMLElement & {
        availableVariants?: string[];
        loaded?: boolean;
      };
      return el?.loaded === true && (el.availableVariants?.length ?? 0) === 3;
    },
    null,
    { timeout: 40_000 },
  );

  const names = await page.evaluate(() => {
    const el = document.querySelector("scene-editor") as HTMLElement & {
      availableVariants: string[];
    };
    return el.availableVariants;
  });
  expect(names).toEqual(["midnight", "beach", "street"]);

  const pick = async (name: string | null): Promise<[number, number, number]> => {
    await page.evaluate((value) => {
      (
        document.querySelector("scene-editor") as HTMLElement & { variantName: string | null }
      ).variantName = value;
    }, name);
    // No camera interaction, no resize, no waiting on an unrelated frame: the
    // runtime itself has to have drawn. One rAF is all a correct implementation
    // needs; the extra budget is for software rasterization, not for a retry.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80))),
    );
    return meanColor(page, await canvasShot(page));
  };

  const base = await meanColor(page, await canvasShot(page));
  const beach = await pick("beach");
  const street = await pick("street");

  // Every pick has to change the frame that is already on screen.
  expect(distance(beach, base)).toBeGreaterThan(8);
  expect(distance(street, beach)).toBeGreaterThan(8);

  // Order independence: the same name reached through a different history has to
  // land on the same colour. This is the "打乱顺序切状态不对" half of the bug.
  const beachAgain = await pick("beach");
  expect(distance(beachAgain, beach)).toBeLessThan(2);
  expect(distance(beachAgain, street)).toBeGreaterThan(8);

  // The asset's *default* material is the midnight colourway (material 0 is
  // `diffuseMidnight`), so picking it is allowed — expected, even — to look like
  // the default. It must not look like whatever was picked before.
  const midnight = await pick("midnight");
  expect(distance(midnight, base)).toBeLessThan(2);
  expect(distance(midnight, street)).toBeGreaterThan(8);

  // Clearing goes back to the asset's own material, not to the last pick.
  const cleared = await pick(null);
  expect(distance(cleared, base)).toBeLessThan(2);

  expect(pageErrors).toEqual([]);
});
