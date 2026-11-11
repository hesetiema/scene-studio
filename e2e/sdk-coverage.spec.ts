import { test, expect, type Page } from "@playwright/test";
import type { HostApiState, ViewerState } from "./support/demo-hooks";

/**
 * SDK full-coverage regression: one test per `?demo=` scenario on minimal.html.
 *
 * The playground (studio UI) covers the viewer-shaped surface; these scenarios
 * cover the API surfaces a host integration hits that the studio does not:
 * multi-select, host commands, inbound updates + conflicts, document migration,
 * the headless facade, and asset resolution/caching.
 *
 * The scenarios used to be standalone `/demos/*.html` pages. They now live on a
 * single HTML entry: `/minimal.html?demo=<name>` injects the same markup and
 * loads the same scenario module, so every `window.__*` hook and every
 * `body.dataset.demo` readiness flag is unchanged. Only the URL moved.
 */

/** Collects uncaught page errors so a scenario cannot regress silently. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

const scenario = (name: string): string => `/minimal.html?demo=${name}`;

test("scenario hub links every focused surface", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(scenario("hub"));
  const links = page.locator(".demo-card");
  await expect(links).toHaveCount(6);
  // `compare` is listed but never visited: it pulls model-viewer from a CDN
  // and exists for eyeball/promo comparison only.
  for (const name of ["host-api", "document", "headless", "assets", "viewer", "compare"]) {
    await expect(page.locator(`a[href="${scenario(name)}"]`)).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test.describe("host API scenario — multi-select, executeCommand, applyRemote", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(scenario("host-api"));
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

test("document scenario — migrate, validate, reject, import", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(scenario("document"));
  await page.waitForFunction(() => document.body.dataset.demo === "ready");

  const migrate = await page.evaluate(() => window.__docDemo.run.migrate());
  // Version-agnostic: the chain must be contiguous and end at the current schema
  // version, so bumping SCHEMA_VERSION never re-breaks this assertion.
  expect(migrate.ok).toBe(true);
  const applied = migrate.applied ?? [];
  expect(applied.length).toBeGreaterThanOrEqual(2);
  expect(applied.map((step) => step.from)).toEqual(applied.map((_, index) => index + 1));
  expect(applied[applied.length - 1]!.to).toBe(migrate.schemaVersion);

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
  expect(imported).toMatchObject({ ok: true, objectCount: 2 });
  expect(imported.schemaVersion).toBe(migrate.schemaVersion);
  await expect
    .poll(() => page.evaluate(() => window.__docDemo.state().loaded))
    .toBe(true);
  expect(errors).toEqual([]);
});

test("headless scenario — createSceneEditor + FakeRuntime passes every check", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(scenario("headless"));
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

test("viewer scenario — model-viewer attribute parity end to end", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(scenario("viewer"));
  await page.waitForFunction(() => document.body.dataset.demo === "ready");

  const state = (): Promise<ViewerState> => page.evaluate(() => window.__viewerDemo.state());
  await expect.poll(async () => (await state()).loaded, { timeout: 20_000 }).toBe(true);

  // autoplay + animation-name: the first clip starts without any host call.
  const first = await state();
  expect(first.clips.length).toBeGreaterThanOrEqual(2);
  expect(first.clipName).toBe(first.clips[0]);
  expect(first.playing).toBe(true);

  // View-level switch: opaque background + a real environment-change event.
  await page.evaluate(() => window.__viewerDemo.actions.setTransparent(false));
  await expect.poll(async () => (await state()).background).toBe("#101624");
  expect((await state()).environmentChanges).toBeGreaterThan(0);

  // auto-rotate is a rAF loop: camera-change must keep arriving.
  const before = (await state()).cameraChanges;
  await page.evaluate(() => window.__viewerDemo.actions.toggle("auto-rotate", true));
  await expect
    .poll(async () => (await state()).cameraChanges, { timeout: 10_000 })
    .toBeGreaterThan(before);
  await page.evaluate(() => window.__viewerDemo.actions.toggle("auto-rotate", false));

  // Camera policy attributes land on the orbit controls.
  await page.evaluate(() => window.__viewerDemo.actions.setLimits("horizontal"));
  await page.evaluate(() => window.__viewerDemo.actions.toggle("disable-zoom", true));
  expect(await state()).toMatchObject({ limits: "horizontal", disabled: { zoom: true } });

  // loading="lazy" on the off-screen probe stays idle until it intersects.
  expect((await state()).probeLoaded).toBe(false);
  await page.evaluate(() => window.__viewerDemo.actions.scrollToProbe());
  await expect.poll(async () => (await state()).probeLoaded, { timeout: 20_000 }).toBe(true);

  expect(errors).toEqual([]);
});

test("assets scenario — resolver, GLB instantiation, cache refcounts", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(scenario("assets"));
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

test("assets scenario — loadFiles() uploads and exportDocument() serializes the document", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto(scenario("assets"));
  await page.waitForFunction(() => document.body.dataset.demo === "ready");

  // The element picks the primary file, mints the Blob URLs and synthesizes the
  // document; the host never touches `URL.createObjectURL`.
  const upload = await page.evaluate(() => window.__assets.actions.loadFile());
  expect(upload).toMatchObject({ ok: true, objects: 1 });
  expect(upload.meshCount).toBeGreaterThan(0);

  // The reserved asset id is not in the host resolver — the element's own
  // resolver has to win for it, otherwise the upload cannot load at all.
  const state = await page.evaluate(() => window.__assets.state());
  expect(state.errors).toEqual([]);
  expect(state.resolved).not.toContain("tri-upload.glb");

  const exported = await page.evaluate(() => window.__assets.actions.exportGlb());
  expect(exported.type).toBe("model/gltf-binary");
  expect(exported.size).toBeGreaterThan(20);

  expect(errors).toEqual([]);
});
