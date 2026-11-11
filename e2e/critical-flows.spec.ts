import { test, expect, type Page } from "@playwright/test";

/**
 * The editor example in the user docs, end to end: load a host document,
 * select, transform, undo/redo and persist through `save-request`.
 *
 * The second case pins the other half of that contract — a stale revision
 * must surface a structured conflict instead of silently overwriting local
 * edits. Playground-specific panel/widget checks are intentionally not here.
 */

declare global {
  interface Window {
    __editor: {
      getDocument: () => { revision: number; objects: unknown[] };
      dirty: boolean;
      revision: number;
      selectedIds: readonly string[];
      selectObject: (id: string) => void;
      applyTransform: (
        id: string,
        from: { position: number[]; rotation: number[]; scale: number[] },
        to: { position: number[]; rotation: number[]; scale: number[] },
      ) => void;
      undo: () => void;
      redo: () => void;
      requestSave: () => void;
    };
    __host: {
      serverDoc: { revision: number };
      saves: number;
    };
    __conflicts: unknown[];
  }
}

async function bootEditor(page: Page): Promise<void> {
  // `?scene=default` pins the deterministic fixture (box-1 / box-2 / gem-1);
  // loaded models are viewers by default, so editor fixtures opt in explicitly.
  await page.goto("/?scene=default&mode=editor");
  await page.waitForFunction(() => document.body.dataset.boot === "ready");
  await expect(page.locator("scene-editor canvas")).toBeVisible();
}

test("editor path: load → select → transform → undo/redo → save", async ({ page }) => {
  await bootEditor(page);

  // load
  const objectCount = await page.evaluate(() => window.__editor.getDocument().objects.length);
  expect(objectCount).toBe(3); // box-1, box-2, gem-1 (assetId)

  // select
  await page.evaluate(() => window.__editor.selectObject("box-1"));
  await expect
    .poll(() => page.evaluate(() => [...window.__editor.selectedIds]))
    .toEqual(["box-1"]);

  // transform → dirty + history
  await page.evaluate(() => {
    window.__editor.applyTransform(
      "box-1",
      { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [1, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    );
  });
  await expect.poll(() => page.evaluate(() => window.__editor.dirty)).toBe(true);

  // undo restores
  await page.evaluate(() => window.__editor.undo());
  await expect.poll(() => page.evaluate(() => window.__editor.dirty)).toBe(false);

  // redo reapplies
  await page.evaluate(() => window.__editor.redo());
  await expect.poll(() => page.evaluate(() => window.__editor.dirty)).toBe(true);

  // save via authoritative path
  await page.evaluate(() => window.__editor.requestSave());
  await expect.poll(() => page.evaluate(() => window.__host.saves)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__editor.revision)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__editor.dirty)).toBe(false);
});

test("stale revision save → structured conflict, no silent overwrite", async ({ page }) => {
  await bootEditor(page);
  // concurrent writer bumps server without telling the client
  await page.evaluate(() => {
    window.__host.serverDoc.revision = 5;
    window.__editor.requestSave();
  });
  await expect.poll(() => page.evaluate(() => window.__conflicts.length)).toBe(1);
  const conflict = await page.evaluate(() => window.__conflicts[0] as {
    base: { revision: number };
    incoming: { revision: number };
    local: { revision: number };
  });
  expect(conflict.incoming.revision).toBe(5);
  expect(conflict.local.revision).toBe(0);
  // local not silently overwritten
  await expect.poll(() => page.evaluate(() => window.__editor.revision)).toBe(0);
});
