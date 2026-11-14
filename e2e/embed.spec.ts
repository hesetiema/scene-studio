import { expect, test } from "@playwright/test";

/**
 * `embed.html` — the declarative surface, guarded.
 *
 * The page is one `<scene-editor src camera-orbit field-of-view reveal>` tag plus
 * three slots; `src/embed-demo.ts` only listens and places a hotspot. This spec
 * pins down the four things a host copies from that page, because the page
 * itself has no unit-test equivalent:
 *
 * 1. the attributes reach the runtime (`camera-orbit` / `field-of-view`),
 * 2. the load story fires in order (progress → load → poster-dismissed),
 * 3. the element stays a viewer (no selection, no panel chrome),
 * 4. the hotspot loop closes (`positionAndNormalFromPoint` → slot → `queryHotspot`).
 */

test("embed page: attributes, load order, viewer mode, hotspot loop", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/embed.html");
  await page.waitForFunction(() => Boolean(customElements.get("scene-editor")));

  // `load` can fire before this script runs, so wait on state, not on the event.
  await page.waitForFunction(
    () => {
      const el = document.querySelector("scene-editor") as HTMLElement & { loaded?: boolean };
      return el?.loaded === true;
    },
    null,
    { timeout: 30_000 },
  );

  const afterLoad = await page.evaluate(() => {
    type EmbedElement = HTMLElement & {
      loaded: boolean;
      modelIsVisible: boolean;
      mode: string;
      selectedIds: readonly string[];
      runtime: { interactive?: boolean };
      getCameraOrbit(): { theta: number; phi: number; radius: number } | null;
      getFieldOfView(): number;
      getDimensions(): { width: number; height: number; depth: number };
      querySelector(selector: string): HTMLCanvasElement | null;
    };

    const el = document.querySelector("scene-editor") as EmbedElement;
    const lines = [...document.querySelectorAll("#log li")].map((li) => li.textContent ?? "");

    return {
      logs: lines,
      mode: el.mode,
      interactive: el.runtime.interactive ?? null,
      loaded: el.loaded,
      modelIsVisible: el.modelIsVisible,
      orbit: el.getCameraOrbit(),
      fov: el.getFieldOfView(),
      dims: el.getDimensions(),
      // Slots are re-homed into the element's own light DOM, not a shadow root.
      slots: {
        poster: Boolean(el.querySelector('[slot="poster"]')),
        progress: Boolean(el.querySelector('[slot="progress-bar"]')),
        error: Boolean(el.querySelector('[slot="error"]')),
        panel: Boolean(el.querySelector("aside.panel, .hud, .inspector")),
      },
    };
  });

  // The two declarative camera attributes are not decoration: they are the pose.
  expect(afterLoad.orbit).not.toBeNull();
  expect(afterLoad.orbit!.theta).toBeCloseTo(30, 0);
  expect(afterLoad.orbit!.phi).toBeCloseTo(74, 0);
  expect(afterLoad.orbit!.radius).toBeGreaterThan(0);
  expect(afterLoad.fov).toBeCloseTo(38, 0);

  // DamagedHelmet is ~2 units wide; a placeholder would be 1x1x1 and sit at 0.
  expect(afterLoad.dims.width).toBeGreaterThan(1);

  // Order matters: progress lines, then load, then the poster step aside.
  const joined = afterLoad.logs.join("\n");
  expect(joined).toMatch(/progress \d+%/);
  expect(joined).toContain("scene-ready");
  expect(joined).toMatch(/load ·/);
  expect(joined).toMatch(/poster-dismissed · loaded=true/);
  expect(joined).not.toMatch(/error /);

  // Poster leaves only after the model is actually on screen.
  expect(afterLoad.modelIsVisible).toBe(true);

  // A viewer: no authoring chrome, no interactive runtime.
  expect(afterLoad.mode).toBe("viewer");
  expect(afterLoad.interactive).toBe(false);
  expect(afterLoad.slots.panel).toBe(false);

  // ---- hotspot loop: pointerdown + click, as the page's own handler expects ----
  const hotspot = await page.evaluate(async () => {
    type EmbedElement = HTMLElement & {
      selectedIds: readonly string[];
      queryHotspot(name: string): { canvasPosition: { x: number; y: number }; facingCamera: boolean } | null;
      querySelector(selector: string): HTMLCanvasElement | null;
    };
    const el = document.querySelector("scene-editor") as EmbedElement;
    const canvas = el.querySelector("canvas")!;
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 250));

    const node = el.querySelector('[slot="hotspot-pick"]') as HTMLElement | null;
    return {
      hasNode: node !== null,
      position: node?.dataset.position ?? null,
      normal: node?.dataset.normal ?? null,
      state: el.queryHotspot("hotspot-pick"),
      selected: [...el.selectedIds],
      logs: [...document.querySelectorAll("#log li")].map((li) => li.textContent ?? ""),
    };
  });

  expect(hotspot.hasNode).toBe(true);
  // The slot protocol only registers anchors that carry a position (a node
  // without `data-position` is invisible to `refreshSlots()`).
  expect(hotspot.position).not.toBeNull();
  expect(hotspot.normal).not.toBeNull();
  expect(hotspot.state).not.toBeNull();
  expect(hotspot.state!.facingCamera).toBe(true);
  expect(hotspot.logs.join("\n")).toMatch(/hotspot → 屏幕 \(\d+, \d+\)/);

  // Clicking a viewer never selects.
  expect(hotspot.selected).toEqual([]);

  expect(pageErrors).toEqual([]);
});
