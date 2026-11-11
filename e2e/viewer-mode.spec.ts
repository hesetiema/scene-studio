import { expect, test } from "@playwright/test";

/**
 * The viewer example from the user docs, end to end: a purely declarative
 * `<scene-editor>` (attributes only, no host JavaScript) renders a real asset,
 * reports `loaded`, owns no authoring chrome and turns no click into a
 * selection. Switching the same element to `mode="editor"` opts into editing.
 *
 * Setting `src` *after* `ready` is an internal regression probe, not a path any
 * documented example takes; it currently stalls at progress 0 (see TODOS.md),
 * so this spec deliberately sticks to the shape users actually copy.
 */

test("viewer example: attributes only; mode=editor enables selection", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/minimal.html");
  await page.waitForFunction(() => Boolean(customElements.get("scene-editor")));

  const probe = await page.evaluate(async () => {
    type ViewerElement = HTMLElement & {
      ready: Promise<void>;
      loaded: boolean;
      mode: string;
      selectedIds: readonly string[];
      availableAnimations: string[];
      runtime: { interactive?: boolean };
      getDimensions(): { width: number; height: number; depth: number };
      querySelector(selector: string): HTMLCanvasElement | null;
    };

    document.querySelectorAll("scene-editor").forEach((node) => node.remove());
    const el = document.createElement("scene-editor") as ViewerElement;

    // The whole viewer configuration, exactly as in the docs: attributes only.
    el.setAttribute("src", "/assets/Fox.glb");
    el.setAttribute("auto-rotate", "");
    el.setAttribute("camera-orbit", "45deg 65deg auto");
    el.setAttribute("alt", "A fox");
    el.style.width = "800px";
    el.style.height = "560px";

    const errors: string[] = [];
    el.addEventListener("error", (event) => {
      errors.push((event as unknown as CustomEvent<{ code: string }>).detail.code);
    });

    document.body.appendChild(el);
    await el.ready;

    // Wait for the real `load` event rather than a fixed sleep: SwiftShader
    // cold starts and parallel workers make any hard-coded delay flaky.
    await new Promise<void>((resolve, reject) => {
      if (el.loaded) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("load event did not fire within 15 s")), 15_000);
      el.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

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

    return {
      mode: el.mode,
      dataMode: el.getAttribute("data-mode"),
      interactive: el.runtime.interactive ?? null,
      loaded: el.loaded,
      dims: el.getDimensions(),
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

  // Fox.glb is ~25 x 79 x 155 — a viewer must never show a 1x1x1 placeholder,
  // and its clips have to be there.
  expect(probe.dims.height).toBeGreaterThan(50);
  expect(probe.animations.length).toBeGreaterThanOrEqual(2);

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
