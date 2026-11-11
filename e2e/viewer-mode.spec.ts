import { expect, test } from "@playwright/test";

/**
 * Viewer vs editor display contract.
 *
 * A `<scene-editor src>` is a **viewer**: it renders, orbits and zooms, but it
 * owns no authoring chrome — no transform axes, no click-to-select. A host
 * document is an **editor**. `mode="viewer|editor"` forces either one.
 *
 * The `src`-after-`ready` case is a regression test: the identity asset resolver
 * used to be built from the attribute present at connect time, so setting `src`
 * later produced a runtime without an `AssetCache` — a 1x1x1 placeholder, an
 * empty clip list, and a normal-looking `load` event.
 */

interface LateSrcProbe {
  mode: string | null;
  dataMode: string | null;
  interactive: boolean | null;
  loaded: boolean;
  dims: { width: number; height: number; depth: number };
  dimsAtLoad: { width: number; height: number; depth: number } | null;
  animations: string[];
  errors: string[];
  selectedAfterClick: string[];
}

test("src set after ready loads the real asset, as a viewer without selection", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/minimal.html");
  await page.waitForFunction(() => Boolean(customElements.get("scene-editor")));

  const probe: LateSrcProbe = await page.evaluate(async () => {
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    document.querySelectorAll("scene-editor").forEach((node) => node.remove());
    const el = document.createElement("scene-editor") as HTMLElement & {
      ready: Promise<void>;
      loaded: boolean;
      mode: string;
      src: string | null;
      selectedIds: readonly string[];
      availableAnimations: string[];
      runtime: { interactive?: boolean };
      getDimensions(): { width: number; height: number; depth: number };
      querySelector(selector: string): HTMLCanvasElement | null;
    };
    el.style.width = "800px";
    el.style.height = "560px";

    const errors: string[] = [];
    let dimsAtLoad: { width: number; height: number; depth: number } | null = null;
    el.addEventListener("error", (event) => {
      const detail = (event as unknown as CustomEvent<{ code: string }>).detail;
      errors.push(detail.code);
    });
    el.addEventListener("load", () => {
      // The harness reads dimensions in the same callback a host would.
      dimsAtLoad = el.getDimensions();
    });

    document.body.appendChild(el);
    await el.ready;
    // The regression: the element connected with no `src` at all.
    el.setAttribute("src", "/assets/Fox.glb");
    await wait(2500);

    const canvas = el.querySelector("canvas")!;
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
      }),
    );
    await wait(150);

    return {
      mode: el.mode,
      dataMode: el.getAttribute("data-mode"),
      interactive: el.runtime.interactive ?? null,
      loaded: el.loaded,
      dims: el.getDimensions(),
      dimsAtLoad,
      animations: el.availableAnimations,
      errors,
      selectedAfterClick: [...el.selectedIds],
    };
  });

  expect(probe.errors).toEqual([]);
  expect(probe.mode).toBe("viewer");
  expect(probe.dataMode).toBe("viewer");
  expect(probe.interactive).toBe(false);
  expect(probe.loaded).toBe(true);

  // Fox.glb is ~25 x 79 x 155 — a document naming an asset must never fall back
  // to the 1x1x1 placeholder, and the clips have to be there.
  expect(probe.dims.height).toBeGreaterThan(50);
  expect(probe.animations.length).toBeGreaterThanOrEqual(2);

  // `load` fires after framing, so a host already sees the real size.
  expect(probe.dimsAtLoad).not.toBeNull();
  expect(probe.dimsAtLoad!.height).toBeCloseTo(probe.dims.height, 1);

  // A viewer turns no click into a selection.
  expect(probe.selectedAfterClick).toEqual([]);

  // Editing mode of the same element: the same click now selects.
  const editorMode = await page.evaluate(async () => {
    const el = document.querySelector("scene-editor") as unknown as {
      mode: string;
      selectedIds: readonly string[];
      runtime: { interactive?: boolean };
      querySelector(selector: string): HTMLCanvasElement | null;
    };
    el.mode = "editor";
    await new Promise((resolve) => setTimeout(resolve, 250));
    const canvas = el.querySelector("canvas")!;
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { mode: el.mode, interactive: el.runtime.interactive ?? null, selected: [...el.selectedIds] };
  });

  expect(editorMode.mode).toBe("editor");
  expect(editorMode.interactive).toBe(true);
  expect(editorMode.selected.length).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});

test("the studio page stays in editor mode with its gizmo", async ({ page }) => {
  // Loaded models are viewers by default (see the next test); editor fixtures
  // opt in through `mode=editor`.
  await page.goto("/?scene=default&select=box-1&mode=editor");
  await page.waitForFunction(() => document.body.dataset.boot === "ready");

  const state = await page.evaluate(() => {
    const el = document.querySelector("scene-editor") as unknown as {
      mode: string;
      selectedIds: readonly string[];
      getAttribute(name: string): string | null;
    };
    const runtime = (
      window as unknown as { __runtime: { interactive?: boolean } }
    ).__runtime;
    return {
      mode: el.mode,
      dataMode: el.getAttribute("data-mode"),
      interactive: runtime.interactive ?? null,
      selected: [...el.selectedIds],
    };
  });

  expect(state.mode).toBe("editor");
  expect(state.dataMode).toBe("editor");
  expect(state.interactive).toBe(true);
  expect(state.selected).toEqual(["box-1"]);
});

/**
 * The studio's own default: a host document is *viewed* first. The top-bar
 * switch is the only way to reach the authoring chrome, and flipping it must
 * stay a pure UI change (no dirty mark, no document write).
 */
test("loaded models open as viewers; the mode switch reveals the editor chrome", async ({
  page,
}) => {
  await page.goto("/?model=fox");
  await page.waitForFunction(() => document.body.dataset.boot === "ready");

  const readMode = () =>
    page.evaluate(() => {
      const el = document.querySelector("scene-editor") as unknown as {
        mode: string;
        dirty: boolean;
        selectedIds: readonly string[];
        getAttribute(name: string): string | null;
      };
      const runtime = (
        window as unknown as { __runtime: { interactive?: boolean } }
      ).__runtime;
      return {
        studio: document.body.dataset.studioMode ?? null,
        mode: el.mode,
        dataMode: el.getAttribute("data-mode"),
        interactive: runtime?.interactive ?? null,
        dirty: el.dirty,
        selected: [...el.selectedIds],
      };
    });

  const viewer = await readMode();
  expect(viewer.studio).toBe("viewer");
  expect(viewer.mode).toBe("viewer");
  expect(viewer.dataMode).toBe("viewer");
  expect(viewer.interactive).toBe(false);
  expect(viewer.dirty).toBe(false);

  await expect(page.locator("#mode-switch")).toBeVisible();
  await expect(page.locator("#mode-viewer")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#control-panel")).toBeHidden();
  await expect(page.locator(".app-footer")).toBeHidden();
  await expect(page.locator("#btn-save")).toBeHidden();

  await page.click("#mode-editor");
  await expect.poll(async () => (await readMode()).mode).toBe("editor");
  const editor = await readMode();
  expect(editor.studio).toBe("editor");
  expect(editor.interactive).toBe(true);
  expect(editor.dirty).toBe(false);

  await expect(page.locator("#control-panel")).toBeVisible();
  await expect(page.locator(".app-footer")).toBeVisible();
  await expect(page.locator("#btn-save")).toBeVisible();
  await expect(page.locator("#mode-editor")).toHaveAttribute("aria-pressed", "true");

  // Selection is editor-only: it must work here and be dropped on the way back.
  const id = await page.evaluate(() => {
    const el = document.querySelector("scene-editor") as unknown as {
      getDocument(): { objects: Array<{ id: string }> };
      selectObject(id: string): void;
    };
    const object = el.getDocument().objects[0]!;
    el.selectObject(object.id);
    return object.id;
  });
  await expect.poll(async () => (await readMode()).selected).toEqual([id]);

  await page.click("#mode-viewer");
  await expect.poll(async () => (await readMode()).mode).toBe("viewer");
  const back = await readMode();
  expect(back.interactive).toBe(false);
  expect(back.selected).toEqual([]);
  expect(back.dirty).toBe(false);
  await expect(page.locator("#control-panel")).toBeHidden();
});
