/**
 * 重拍 `demos.html` 里两张示例卡片的缩略图：`public/demos/*.jpg`。
 *
 *   node apps/playground/scripts/capture-demo-thumbs.mjs
 *
 * 只有**示例**（工作台、通风感知）配截图。接入参考（embed / minimal）与内部工具
 * （perf）故意不给图：它们的价值在代码和数字里，一张截图只会让人以为那是"能看的
 * 东西"。所以这个脚本不拍它们，`public/demos/` 里也不该出现它们的文件。
 *
 * 前提：playground dev server 已在 127.0.0.1:3000 上跑着（`pnpm --filter
 * @scenio/playground dev`），且 `public/data/vent` 与 `public/bim` 的本地快照在位
 * （否则 vent 那张会拍到「准备中」提示卡）。
 *
 * 串行拍摄：SwiftShader 只有一个软件光栅器，并行页面会互相抢占并让截图挂死；
 * 每页失败重试一次。
 *
 * `hide` 里的选择器在拍摄前被 display:none，并且截图会裁掉它们所在的那条边：
 * vent demo 的左栏是从真实数据快照渲染出来的楼栋 / 楼层名称，而仓库是公开的，
 * 这类内部标识不能出现在入库的图片里。裁切也让卡片里只剩模型，
 * 而不是一张「带侧边栏的产品截图」。新增卡片时同样先想一遍「这一屏有没有不该
 * 公开的东西」。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.PLAYGROUND_URL ?? "http://127.0.0.1:3000";
const OUT = fileURLToPath(new URL("../public/demos/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/**
 * 每张卡片一项：
 * - `hide`      拍前 display:none 的选择器（不想进画面的 UI）
 * - `cropLeft`  裁掉这个选择器所占的左侧宽度（用于去掉侧边栏本身留出的空白）
 */
const SHOTS = [
  { file: "studio.jpg", url: "/?model=damaged-helmet&mode=editor", wait: 9_000 },
  {
    file: "vent.jpg",
    url: "/vent-demo.html",
    wait: 12_000,
    hide: ["#nav", "#legend"],
    cropLeft: "#nav",
  },
];

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--force-color-profile=srgb",
  ],
});

let failed = 0;

for (const shot of SHOTS) {
  let captured = false;

  for (let attempt = 1; attempt <= 2 && !captured; attempt += 1) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 760 },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(BASE + shot.url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForTimeout(shot.wait);

      let clip;
      if (shot.cropLeft) {
        // 先量宽度再隐藏：display:none 之后 boundingBox 就归零了。
        const inset = await page.evaluate((selector) => {
          const node = document.querySelector(selector);
          return node ? Math.round(node.getBoundingClientRect().right) : 0;
        }, shot.cropLeft);
        if (inset > 0 && inset < 1280) {
          clip = { x: inset, y: 0, width: 1280 - inset, height: 760 };
        }
      }

      if (shot.hide?.length) {
        await page.addStyleTag({ content: `${shot.hide.join(",")} { display: none !important; }` });
        await page.waitForTimeout(400);
      }

      await page.screenshot({ path: `${OUT}${shot.file}`, type: "jpeg", quality: 82, clip });
      console.log(`ok   ${shot.file} (attempt ${attempt})`);
      captured = true;
    } catch (error) {
      console.warn(`fail ${shot.file} (attempt ${attempt}): ${String(error).split("\n")[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (!captured) failed += 1;
}

await browser.close();
process.exit(failed === 0 ? 0 : 1);
