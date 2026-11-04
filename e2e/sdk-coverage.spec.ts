import { test, expect, type Page } from "@playwright/test";
import type { HostApiState } from "./support/demo-hooks";

/**
 * SDK full-coverage regression: one test per focused demo page under /demos.
 *
 * The playground (studio UI) covers the viewer-shaped surface; these pages exist
 * for the API surfaces a host integration hits that the studio does not:
 * multi-select, host commands, inbound updates + conflicts, document migration,
 * the headless facade, and asset resolution/caching.
 */

/** Collects uncaught page errors so a demo cannot regress silently. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("demo hub lists every focused page", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/demos/");
  const links = page.locator(".demo-card");
  await expect(links).toHaveCount(4);
  for (const href of [
    "/demos/host-api.html",
    "/demos/document.html",
    "/demos/headless.html",
    "/demos/assets.html",
  ]) {
    await expect(page.locator(`a[href="${href}"]`)).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test.describe("host API demo — multi-select, executeCommand, applyRemote", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/demos/host-api.html");
    await page.waitForFunction(() => document.body.dataset.demo === "ready");
    await expect(page.locator("scene-editor canvas")).toBeVisible();
  });

  test("multi-select composes and broadcasts", async ({ page }) => {
    const errors = watchErrors(page);
    const state = (): Promise<HostApiState> => page.evaluate(() => window.__demo.state());

    expect(await state()).toMatchObject({ selected: ["box-1"], revision: 0, conflict: null });

    await page.evaluate(() => window.__demo.actions.selectAll());
    expect((await state()).selected).toEqual(["box-1", "box-2", "box-3"]);

    await page.evaluate(() => window.__demo.actions.toggleBox2());
    expect((await state()).selected).toEqual(["box-1", "box-3"]);
    expect(errors).toEqual([]);
  });

  test("executeCommand joins the same undo stack", async ({ page }) => {
    const state = (): Promise<HostApiState> => page.evaluate(() => window.__demo.state());

    await page.evaluate(() => window.__demo.actions.selectAll());
    await page.evaluate(() => window.__demo.actions.tag());
    expect(Object.keys((await state()).labels)).toHaveLength(3);

    await page.evaluate(() => window.__demo.actions.undo());
    expect((await state()).labels).toEqual({});
  });

  test("applyRemote fast-forwards a clean editor, conflicts when dirty", async ({ page }) => {
    const state = (): Promise<HostApiState> => page.evaluate(() => window.__demo.state());

    expect(await page.evaluate(() => window.__demo.actions.pushRemote())).toBe("fast-forward");
    expect(await state()).toMatchObject({ revision: 1, serverRevision: 1, dirty: false });

    await page.evaluate(() => window.__demo.actions.localEdit());
    expect(await page.evaluate(() => window.__demo.actions.pushRemote())).toBe("conflict");
    expect((await state()).conflict).toEqual({ base: 1, incoming: 2, local: 1 });
    expect((await state()).revision).toBe(1); // local doc untouched
  });

  test("host resolves a conflict by keeping local edits", async ({ page }) => {
    const state = (): Promise<HostApiState> => page.evaluate(() => window.__demo.state());
    await page.evaluate(() => window.__demo.actions.localEdit());
    await page.evaluate(() => window.__demo.actions.pushRemote());
    await page.evaluate(() => window.__demo.actions.keepLocal());

    // local r0 dirty, server r1 → conflict; keepLocal adopts r1 then saves as r2.
    await expect.poll(async () => (await state()).revision).toBe(2);
    expect(await state()).toMatchObject({ dirty: false, conflict: null, serverRevision: 2 });
  });
});

test("document demo — migrate, validate, reject, import", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/demos/document.html");
  await page.waitForFunction(() => document.body.dataset.demo === "ready");

  const migrate = await page.evaluate(() => window.__docDemo.run.migrate());
  expect(migrate).toMatchObject({
    ok: true,
    schemaVersion: 2,
    applied: [{ from: 1, to: 2 }],
  });

  expect(await page.evaluate(() => window.__docDemo.run.badHierarchy())).toMatchObject({
    ok: false,
    code: "validation",
  });
  expect(await page.evaluate(() => window.__docDemo.run.badColor())).toMatchObject({
    ok: false,
    code: "validation",
  });
  expect(await page.evaluate(() => window.__docDemo.run.badVersion())).toMatchObject({
    ok: false,
    code: "validation",
  });

  const imported = await page.evaluate(() => window.__docDemo.run.importDoc());
  expect(imported).toMatchObject({ ok: true, schemaVersion: 2, objectCount: 2 });
  await expect
    .poll(() => page.evaluate(() => window.__docDemo.state().loaded))
    .toBe(true);
  expect(errors).toEqual([]);
});

test("headless demo — createSceneEditor + FakeRuntime passes every check", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/demos/headless.html");
  await page.waitForFunction(() => document.body.dataset.coverage !== undefined);

  const report = await page.evaluate(() => window.__coverage.report());
  expect(report.failed).toBe(0);
  expect(report.passed).toBe(report.checks.length);
  expect(report.checks.length).toBeGreaterThanOrEqual(11);
  expect(report.checks.map((check) => check.name)).toContain(
    "applyRemote：本地脏 → 结构化冲突",
  );
  expect(errors).toEqual([]);
});

test("assets demo — resolver, GLB instantiation, cache refcounts", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/demos/assets.html");
  await page.waitForFunction(() => document.body.dataset.demo === "ready");

  expect(await page.evaluate(() => window.__assets.actions.loadTri())).toMatchObject({ ok: true });
  const loaded = await page.evaluate(() => window.__assets.state());
  expect(loaded.resolved).toContain("tri");
  expect(loaded.meshCount).toBeGreaterThan(0);
  expect(loaded.errors).toEqual([]);

  // A throwing resolver must surface the documented code, not a generic load error.
  expect(await page.evaluate(() => window.__assets.actions.loadMissing())).toMatchObject({
    ok: false,
    code: "asset-resolve-failed",
  });

  const cache = await page.evaluate(() => window.__assets.actions.runCache());
  expect(cache).toMatchObject({
    sameInstance: true,
    collapsedLoads: 1,
    collapsedRefs: 2,
    totalLoads: 2,
    totalDisposes: 1,
  });
  expect(errors).toEqual([]);
});
