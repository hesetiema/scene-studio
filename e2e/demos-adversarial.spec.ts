import { test, expect, type Page } from "@playwright/test";

/**
 * Adversarial regression for the /demos pages.
 *
 * These are the hostile-input / hostile-timing cases the happy-path coverage
 * suite does not exercise:
 *   - untrusted document data reaching the DOM (injection)
 *   - repeated / out-of-order operations (undo storms, inert conflict actions)
 *   - concurrent document loads (duplicate scene nodes, last-call-wins)
 *   - resolver trust boundary (unknown ids, path traversal)
 *   - malformed input and prototype pollution
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

type EditorHandle = {
  clearSelection(): void;
  select(ids: string[]): void;
  getDocument(): { sceneId: string; objects: Array<{ id: string }> };
  loadDocument(doc: unknown): Promise<void>;
};

const editorHandle = (): EditorHandle =>
  document.querySelector("scene-editor") as unknown as EditorHandle;

test.describe("host API demo — hostile input and timing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/demos/host-api.html");
    await page.waitForFunction(() => document.body.dataset.demo === "ready");
  });

  test("tagging with an empty selection is rejected, not thrown", async ({ page }) => {
    const errors = watchErrors(page);
    const result = await page.evaluate(() => {
      const el = document.querySelector("scene-editor") as unknown as EditorHandle;
      el.clearSelection();
      window.__demo.actions.tag();
      return {
        state: window.__demo.state(),
        log: document.querySelector("#log")?.textContent ?? "",
      };
    });

    expect(result.state.labels).toEqual({});
    expect(result.log).toContain("先选中对象再打标签");
    expect(errors).toEqual([]);
  });

  test("40 undo/redo cycles leave a consistent editor", async ({ page }) => {
    const errors = watchErrors(page);
    const state = await page.evaluate(() => {
      window.__demo.actions.selectAll();
      window.__demo.actions.tag();
      for (let i = 0; i < 40; i++) {
        window.__demo.actions.undo();
        window.__demo.actions.redo();
      }
      window.__demo.actions.undo();
      return window.__demo.state();
    });

    expect(state).toMatchObject({ dirty: false, revision: 0, labels: {} });
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);
    expect(errors).toEqual([]);
  });

  test("five clean remote pushes fast-forward monotonically", async ({ page }) => {
    const errors = watchErrors(page);
    const result = await page.evaluate(async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 5; i++) outcomes.push(await window.__demo.actions.pushRemote());
      return { outcomes, state: window.__demo.state() };
    });

    expect(result.outcomes).toEqual(Array(5).fill("fast-forward"));
    expect(result.state).toMatchObject({ revision: 5, serverRevision: 5, dirty: false });
    expect(errors).toEqual([]);
  });

  test("two pushes while dirty keep the newest server revision", async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__demo.actions.localEdit();
      const first = await window.__demo.actions.pushRemote();
      const second = await window.__demo.actions.pushRemote();
      const conflict = window.__demo.state().conflict;
      window.__demo.actions.keepLocal();
      return { first, second, conflict, state: window.__demo.state() };
    });

    expect(result.first).toBe("conflict");
    expect(result.second).toBe("conflict");
    expect(result.conflict).toEqual({ base: 0, incoming: 2, local: 0 });
    expect(result.state).toMatchObject({ revision: 3, serverRevision: 3, dirty: false });
  });

  test("conflict actions are inert without a conflict", async ({ page }) => {
    const errors = watchErrors(page);
    const state = await page.evaluate(async () => {
      await window.__demo.actions.takeRemote();
      await window.__demo.actions.reloadBase();
      window.__demo.actions.keepLocal();
      return window.__demo.state();
    });

    expect(state).toMatchObject({ revision: 0, serverRevision: 0, dirty: false, conflict: null });
    expect(errors).toEqual([]);
  });

  test("shift-click on empty canvas preserves the multi-selection", async ({ page }) => {
    const selected = await page.evaluate(() => {
      const el = document.querySelector("scene-editor") as unknown as {
        select(ids: string[]): void;
        querySelector(selector: string): HTMLCanvasElement | null;
      };
      el.select(["box-1", "box-3"]);
      const canvas = el.querySelector("canvas")!;
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent("click", {
          clientX: rect.left + 8,
          clientY: rect.top + 8,
          shiftKey: true,
          bubbles: true,
        }),
      );
      return window.__demo.state().selected;
    });

    expect(selected).toEqual(["box-1", "box-3"]);
  });
});

test.describe("document demo — untrusted input", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/demos/document.html");
    await page.waitForFunction(() => document.body.dataset.demo === "ready");
  });

  test("scene data cannot inject markup into the page", async ({ page }) => {
    const errors = watchErrors(page);
    const result = await page.evaluate(async () => {
      const payload = '<img src=x onerror="window.__xss=1">';
      const doc = {
        schemaVersion: 1,
        sceneId: payload,
        revision: 0,
        objects: [
          {
            id: "box",
            type: "mesh",
            name: "Box",
            position: [0, 0.5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      };
      (document.querySelector("#source") as HTMLTextAreaElement).value = JSON.stringify(doc);
      await window.__docDemo.run.importDoc();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const status = document.querySelector("#status")!;
      return {
        xssFlag: "__xss" in window,
        injectedNodes: status.querySelectorAll("img, script").length,
        text: status.textContent ?? "",
      };
    });

    expect(result.xssFlag).toBe(false);
    expect(result.injectedNodes).toBe(0);
    expect(result.text).toContain("<img src=x");
    expect(errors).toEqual([]);
  });

  test("malformed textarea input reports a stable code", async ({ page }) => {
    const results = await page.evaluate(() => {
      const source = document.querySelector("#source") as HTMLTextAreaElement;
      source.value = "";
      const empty = window.__docDemo.run.migrate();
      source.value = "{ nope";
      const junk = window.__docDemo.run.migrate();
      return { empty, junk };
    });

    expect(results.empty).toMatchObject({ ok: false, code: "invalid-json" });
    expect(results.junk).toMatchObject({ ok: false, code: "invalid-json" });
  });

  test("hierarchy validation works for a single-object document", async ({ page }) => {
    const result = await page.evaluate(() => {
      const doc = {
        schemaVersion: 1,
        sceneId: "one",
        revision: 0,
        objects: [
          {
            id: "only",
            type: "mesh",
            name: "Only",
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      };
      (document.querySelector("#source") as HTMLTextAreaElement).value = JSON.stringify(doc);
      return window.__docDemo.run.badHierarchy();
    });

    expect(result).toMatchObject({ ok: false, code: "validation" });
  });

  test("800-object document imports without stalling and never pollutes Object.prototype", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const objects = Array.from({ length: 800 }, (_, i) => ({
        id: `bulk-${i}`,
        type: "mesh",
        name: `Bulk ${i}`,
        position: [i % 20, 0.5, Math.floor(i / 20)],
        rotation: [0, 0, 0],
        scale: [0.2, 0.2, 0.2],
      }));
      (document.querySelector("#source") as HTMLTextAreaElement).value = JSON.stringify({
        schemaVersion: 1,
        sceneId: "bulk",
        revision: 0,
        __proto__: { polluted: true },
        objects,
      });

      const started = performance.now();
      const imported = await window.__docDemo.run.importDoc();
      return {
        imported,
        ms: performance.now() - started,
        polluted: ({} as { polluted?: boolean }).polluted ?? null,
        state: window.__docDemo.state(),
      };
    });

    expect(result.imported.ok).toBe(true);
    expect(result.imported.objectCount).toBe(800);
    expect(result.ms).toBeLessThan(5000);
    expect(result.polluted).toBeNull();
    expect(result.state).toMatchObject({ loaded: true, sceneId: "bulk" });
  });
});

test.describe("assets demo — resolver boundary and load races", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/demos/assets.html");
    await page.waitForFunction(() => document.body.dataset.demo === "ready");
  });

  test("unsupported formats and unknown ids surface their own codes", async ({ page }) => {
    const errors = watchErrors(page);
    const result = await page.evaluate(async () => {
      const el = document.querySelector("scene-editor") as unknown as EditorHandle;
      const unsupported = await window.__assets.actions.loadUnsupported();
      const before = window.__assets.state().errors.length;
      await el.loadDocument(window.__assets.makeDoc("../../etc/passwd", "traversal"));
      const after = window.__assets.state().errors;
      return { unsupported, added: after.slice(before) };
    });

    expect(result.unsupported).toMatchObject({ ok: false, code: "asset-unsupported-format" });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ code: "asset-resolve-failed" });
    expect(errors).toEqual([]);
  });

  test("concurrent duplicate loads do not duplicate scene nodes", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.querySelector("scene-editor") as unknown as EditorHandle;
      const single = await window.__assets.actions.loadTri();
      const baseline = window.__assets.state().meshCount;
      const doc = window.__assets.makeDoc("tri", "dup-race");
      await Promise.all([el.loadDocument(doc), el.loadDocument(doc)]);
      return {
        single,
        baseline,
        sceneId: window.__assets.state().sceneId,
        meshCount: window.__assets.state().meshCount,
      };
    });

    expect(result.single).toMatchObject({ ok: true });
    expect(result.baseline).toBeGreaterThan(0);
    expect(result.sceneId).toBe("dup-race");
    expect(result.meshCount).toBe(result.baseline); // exactly one instance, not two
  });

  test("fire-and-forget loads are resolved in call order", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.querySelector("scene-editor") as unknown as EditorHandle;
      const first = window.__assets.makeDoc("tri", "race-first");
      const second = window.__assets.makeDoc("missing", "race-second");
      await Promise.all([el.loadDocument(first), el.loadDocument(second)]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        sceneId: window.__assets.state().sceneId,
        meshCount: window.__assets.state().meshCount,
      };
    });

    expect(result.sceneId).toBe("race-second");
    expect(result.meshCount).toBe(0); // no orphaned mesh from the superseded load
  });

  test("rapid alternating loads stay consistent", async ({ page }) => {
    const errors = watchErrors(page);
    const result = await page.evaluate(async () => {
      const outcomes = [];
      for (let i = 0; i < 3; i++) {
        outcomes.push(await window.__assets.actions.loadTri());
        outcomes.push(await window.__assets.actions.loadMissing());
      }
      return {
        outcomes,
        state: window.__assets.state(),
        errorCount: window.__assets.state().errors.length,
      };
    });

    expect(result.outcomes.filter((outcome) => outcome.ok)).toHaveLength(3);
    expect(result.outcomes.filter((outcome) => !outcome.ok)).toHaveLength(3);
    expect(result.state).toMatchObject({ sceneId: "asset-missing", meshCount: 0 });
    expect(result.errorCount).toBe(3);
    expect(errors).toEqual([]);
  });
});

test("headless demo is idempotent across reloads", async ({ page }) => {
  const errors = watchErrors(page);
  for (let run = 0; run < 3; run++) {
    await page.goto("/demos/headless.html");
    await page.waitForFunction(() => document.body.dataset.coverage !== undefined);
    const report = await page.evaluate(() => window.__coverage.report());
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.checks.length);
  }
  expect(errors).toEqual([]);
});
