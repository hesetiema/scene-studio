import { expect, test } from "@playwright/test";

type RuntimeHook = {
  camera?: { position: { x: number; y: number; z: number } };
  events: { emit(type: string, payload: unknown): void };
  getViewState(): unknown;
};
type SavedDoc = { view?: { camera: { position: number[]; fov: number } } } & Record<string, unknown>;

test("camera view survives save and reload", async ({ page }) => {
  await page.goto("/?scene=default&mode=editor");
  // Wait for the boot document: `ready` only means the runtime mounted, and a
  // view-change/save before the first document has no document to record.
  await page.waitForFunction(() => document.body.dataset.boot === "ready");
  const el = page.locator("scene-editor");
  await el.evaluate((node) => (node as { ready: Promise<void> }).ready);

  // Move the camera the way a user would, through the runtime seam.
  await page.evaluate(() => {
    const runtime = (window as unknown as { __runtime?: RuntimeHook }).__runtime;
    if (!runtime) throw new Error("__runtime test hook missing");
    if (runtime.camera) {
      runtime.camera.position.x = 3;
      runtime.camera.position.y = 9;
    }
    // simulate the interaction end event OrbitControls would raise
    runtime.events.emit("view-change", { view: runtime.getViewState() });
  });

  await el.evaluate((node) => (node as { requestSave(): void }).requestSave());

  const savedView = await page.evaluate(() => {
    const saved = (window as unknown as { __savedDocs?: SavedDoc[] }).__savedDocs;
    return saved?.[0]?.view ?? null;
  });
  expect(savedView).toBeTruthy();
  expect(savedView!.camera.fov).toBeGreaterThan(0);

  // Reload as a new scene and confirm the camera is restored, not re-defaulted.
  await el.evaluate((node) => {
    const saved = (window as unknown as { __savedDocs: SavedDoc[] }).__savedDocs;
    return (node as { loadDocument(d: unknown): Promise<void> }).loadDocument({
      ...saved[0]!,
      sceneId: "scene-reloaded",
    });
  });

  const restored = await page.evaluate(() => {
    const runtime = (window as unknown as { __runtime?: RuntimeHook }).__runtime;
    return runtime?.getViewState() as { camera: { position: number[] } } | undefined;
  });

  // OrbitControls re-derives the camera position from spherical coordinates on
  // the next update, so the restored value is identical to ~1e-15, not bit-equal.
  const restoredPosition = restored!.camera.position;
  expect(restoredPosition).toHaveLength(savedView!.camera.position.length);
  restoredPosition.forEach((value, index) => {
    expect(value).toBeCloseTo(savedView!.camera.position[index]!, 6);
  });
});
