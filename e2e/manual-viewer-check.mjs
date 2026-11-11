/**
 * Manual claim check for `<scene-editor>` viewer attributes — not a Playwright
 * spec, so it is not part of `pnpm test:e2e`.
 *
 * It runs against a *production* build, because the dev server's module cache hid
 * a stale bundle once and made this look like a code bug:
 *
 *   pnpm --filter playground build
 *   npx vite preview --port 4180 --strictPort   # from apps/playground
 *   node e2e/manual-viewer-check.mjs
 *
 * Covers what unit tests cannot: the real OrbitControls / TransformControls
 * connect order (`touch-action`), an actual HDR decode, and whether the eased
 * pose already landed when the attribute is read back.
 */
import { chromium } from "@playwright/test";

const URL = "http://127.0.0.1:4180/minimal.html?demo=viewer";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const notFound = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // Ignore a missing favicon: the demo page ships no icon.
  if (/favicon/i.test(m.location()?.url ?? "")) return;
  errors.push(`${m.text()} @ ${m.location()?.url ?? "?"}`);
});
page.on("response", (r) => {
  if (r.status() === 404 && !/favicon/i.test(r.url())) notFound.push(r.url());
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__viewerDemo?.state().loaded === true, { timeout: 30000 });

const state = () => page.evaluate(() => window.__viewerDemo.state());
const act = (fn, ...args) =>
  page.evaluate(({ fn, args }) => window.__viewerDemo.actions[fn](...args), { fn, args });

const dirtyAtStart = await page.evaluate(() => document.querySelector("scene-editor").dirty);

// ---- touch-action -----------------------------------------------------------
check("touch-action defaults to pan-y", (await state()).touchAction === "pan-y", (await state()).touchAction);
await act("setTouchAction", "none");
check("touch-action=none reaches the canvas", (await state()).touchAction === "none");
await act("setTouchAction", "pan-y");

// ---- orbit-sensitivity ------------------------------------------------------
await act("setOrbitSensitivity", 0.5);
check("orbit-sensitivity recorded", (await state()).orbitSensitivity === 0.5);
await act("setOrbitSensitivity", -1);
check("negative orbit-sensitivity survives", (await state()).orbitSensitivity === -1);
await act("setOrbitSensitivity", 1);

// ---- with-credentials -------------------------------------------------------
await act("setWithCredentials", true);
check("with-credentials attribute lands", (await state()).withCredentials === true);
await act("setWithCredentials", false);

// ---- environment-image as an HDR URL ---------------------------------------
const beforeEnv = await state();
await act("setEnvironment", "/assets/test-studio.hdr", null);
await page.waitForTimeout(2500);
const afterEnv = await state();

check(
  "HDR replaces the studio environment map",
  afterEnv.environmentMapId !== null && afterEnv.environmentMapId !== beforeEnv.environmentMapId,
  `${beforeEnv.environmentMapId} → ${afterEnv.environmentMapId}`,
);
check(
  "environment-image alone does not change the backdrop",
  afterEnv.backgroundIsTexture === false,
  String(afterEnv.backgroundIsTexture),
);

// ---- skybox-image -----------------------------------------------------------
await act("setEnvironment", null, "/assets/test-studio.hdr");
await page.waitForTimeout(2500);
const sky = await state();
check("skybox-image becomes the visible backdrop", sky.backgroundIsTexture === true, String(sky.backgroundIsTexture));
check("skybox-image alone also lights the model", sky.environmentMapId !== null, String(sky.environmentMapId));

await act("setEnvironment", null, null);
await page.waitForTimeout(1500);
const cleared = await state();
check("clearing both returns to the preset studio", cleared.backgroundIsTexture === false);

// ---- camera transition ------------------------------------------------------
await act("setInterpolationDecay", 400);
check("interpolation-decay recorded", (await state()).interpolationDecay === 400);

const fade = await page.evaluate(async () => {
  const el = document.querySelector("scene-editor");
  const before = el.getCameraOrbit();
  el.setAttribute("camera-orbit", "120deg auto auto");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const mid = el.getCameraOrbit();
  await new Promise((r) => setTimeout(r, 1500));
  const end = el.getCameraOrbit();
  return { before: before?.theta ?? null, mid: mid?.theta ?? null, end: end?.theta ?? null };
});
check(
  "camera-orbit change fades instead of snapping",
  fade.mid !== null && Math.abs(fade.mid - 120) > 1 && Math.abs(fade.mid - (fade.before ?? 0)) > 0.01,
  JSON.stringify(fade),
);
check("the fade settles on the goal", fade.end !== null && Math.abs(fade.end - 120) < 0.5, String(fade.end));

const jump = await page.evaluate(async () => {
  const el = document.querySelector("scene-editor");
  el.setAttribute("interpolation-decay", "2000");
  el.setAttribute("camera-orbit", "0deg auto auto");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const mid = el.getCameraOrbit()?.theta ?? null;
  const ok = el.jumpCameraToGoal();
  const after = el.getCameraOrbit()?.theta ?? null;
  return { mid, ok, after };
});
check(
  "jumpCameraToGoal() lands immediately",
  jump.ok === true && Math.abs(jump.after ?? 999) < 0.5 && Math.abs(jump.mid ?? 0) > 0.5,
  JSON.stringify(jump),
);

// ---- turntable reset --------------------------------------------------------
const turntable = await page.evaluate(async () => {
  const el = document.querySelector("scene-editor");
  el.setAttribute("interpolation-decay", "50");
  el.setAttribute("rotation-per-second", "120");
  el.setAttribute("auto-rotate", "");
  await new Promise((r) => setTimeout(r, 700));
  // Stop the turntable first, otherwise it keeps spinning past the reset.
  el.removeAttribute("auto-rotate");
  await new Promise((r) => requestAnimationFrame(r));
  const spun = el.getCameraOrbit()?.theta ?? null;
  const ok = el.resetTurntableRotation();
  await new Promise((r) => requestAnimationFrame(r));
  const reset = el.getCameraOrbit()?.theta ?? null;
  return { spun, ok, reset };
});
check(
  "resetTurntableRotation() zeroes the turntable yaw",
  turntable.ok === true && Math.abs(turntable.reset ?? 999) < 1,
  JSON.stringify(turntable),
);

// ---- loaded / modelIsVisible -----------------------------------------------
const claim = await page.evaluate(() => {
  const el = document.querySelector("scene-editor");
  return {
    loaded: el.loaded,
    modelIsVisible: el.modelIsVisible,
    visible: el.visible,
    posterLeft: document.querySelector('scene-editor [slot="poster"]')?.style.display ?? "none",
  };
});
check("loaded is true once the load event has fired", claim.loaded === true);
// The element is in the viewport and the poster is gone, so the verdict must
// agree with its two inputs rather than just mirroring the intersection.
check(
  "modelIsVisible = loaded × viewport × poster dismissed",
  claim.modelIsVisible === (claim.loaded && claim.visible),
  JSON.stringify(claim),
);

// ---- transport events -------------------------------------------------------
const transport = await page.evaluate(async () => {
  const el = document.querySelector("scene-editor");
  const seen = [];
  for (const type of ["play", "pause", "loop", "finished"]) {
    el.addEventListener(type, () => seen.push(type));
  }
  const started = el.play();
  await new Promise((r) => setTimeout(r, 700));
  el.pause();
  return { started, seen, clips: el.availableAnimations.length, paused: el.paused };
});
check(
  "play() / pause() reach the element as events",
  transport.started === true &&
    transport.seen.includes("play") &&
    transport.seen.includes("pause") &&
    transport.paused === true,
  JSON.stringify(transport),
);

// ---- updateHotspot ----------------------------------------------------------
await page.click("#add-hotspots");
const moved = await page.evaluate(() => {
  const el = document.querySelector("scene-editor");
  const before = el.queryHotspot("hotspot-front");
  if (!before) return { ok: false, reason: "no anchor" };
  el.updateHotspot({
    name: "hotspot-front",
    position: `${before.position.x} ${before.position.y + 0.2} ${before.position.z}`,
  });
  const after = el.queryHotspot("hotspot-front");
  return { ok: true, beforeY: before.position.y, afterY: after?.position.y ?? null };
});
check(
  "updateHotspot() moves the anchor without a DOM write",
  moved.ok === true && Math.abs((moved.afterY ?? 0) - ((moved.beforeY ?? 0) + 0.2)) < 1e-6,
  JSON.stringify(moved),
);
await page.click("#remove-hotspots");

// ---- document stays clean ---------------------------------------------------
// The demo itself writes view state on load (`syncEnvironmentSwitches`), so the
// honest assertion is that viewer chrome does not dirty it *further*.
const dirty = await page.evaluate(() => document.querySelector("scene-editor").dirty);
check(
  "viewer attributes never dirty the document",
  dirty === dirtyAtStart,
  `at load ${dirtyAtStart} → after all viewer ops ${dirty}`,
);

const realErrors = errors.filter((e) => !/favicon/i.test(e));
check("no page errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | ").slice(0, 200));
check(
  "no unexpected 404s",
  notFound.length === 0,
  notFound.join(" | ").slice(0, 160),
);

await page.screenshot({ path: "C:/Users/wuyuxi/AppData/Local/Temp/viewer-interaction.png" });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
