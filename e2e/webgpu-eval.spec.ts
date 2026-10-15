import { test, expect, type Browser } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";

// WebGPU eval needs a real adapter. On this host headless Chromium returns
// requestAdapter()=null for every backend (incl. --use-webgpu-adapter=swiftshader);
// headed yields the Intel iGPU with requestDevice() OK. --enable-unsafe-webgpu
// keeps the eval working even where WebGPU is still flagged.
//
// OPT-IN: headed is not CI-safe and flashes a window — skipped unless requested.
// Re-run: PowerShell  $env:RUN_WEBGPU_EVAL='1'; pnpm test:e2e webgpu-eval
test.use({
  headless: false,
  launchOptions: { args: ["--enable-unsafe-webgpu"] },
});

interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface ProbeReport {
  status: "running" | "ready" | "done" | "failed";
  conclusion: "webgpu-viable" | "keep-webgl" | "pending";
  conclusionReason: string;
  timestamp: string;
  userAgent: string;
  gpuPresent: boolean;
  adapter: boolean;
  adapterInfo: string;
  backend: "webgpu" | "webgl" | "none";
  checks: ProbeCheck[];
  errors: string[];
  runtimeErrors: Array<{ code: string; message: string }>;
  notCovered: string[];
}

declare global {
  interface Window {
    __webgpuProbe: {
      report: ProbeReport;
      finish: () => Promise<void>;
    };
  }
}

function writeReport(browser: Browser, pageErrors: string[], shotBytes: number, report: ProbeReport): void {
  const out = {
    ...report,
    chromiumVersion: browser.version(),
    pageErrors,
    screenshotBytes: shotBytes,
  };
  const file = path.join(test.info().config.rootDir, "webgpu-eval-report.json");
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

test.describe("D1 WebGPU evaluation", () => {
  test.skip(!process.env.RUN_WEBGPU_EVAL, "opt-in eval: set RUN_WEBGPU_EVAL=1");

  test("real-asset matrix renders viable or records keep-webgl", async ({ page, browser }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/webgpu.html");
    await page.waitForFunction(
      () => {
        const api = window.__webgpuProbe;
        return api.report.status === "ready" || api.report.status === "failed";
      },
      undefined,
      { timeout: 90_000 },
    );
    let report = await page.evaluate(() => window.__webgpuProbe.report);

    // No WebGPU at all → record the evidence, then skip (conclusion: keep-webgl).
    if (!report.gpuPresent || !report.adapter) {
      await page.evaluate(() => window.__webgpuProbe.finish());
      report = await page.evaluate(() => window.__webgpuProbe.report);
      writeReport(browser, pageErrors, 0, report);
      test.skip(true, `WebGPU unavailable: ${report.conclusionReason}`);
    }

    // Screenshot BEFORE dispose (two-phase handshake) — non-blank frame proof.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const shot = await page.locator("#c").screenshot();

    await page.evaluate(() => window.__webgpuProbe.finish());
    await page.waitForFunction(() => window.__webgpuProbe.report.status === "done", undefined, {
      timeout: 30_000,
    });
    report = await page.evaluate(() => window.__webgpuProbe.report);
    writeReport(browser, pageErrors, shot.length, report);

    // Verdict: everything must be green on a real WebGPU backend.
    expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.backend).toBe("webgpu");
    expect(shot.length, "canvas screenshot must be a non-blank frame").toBeGreaterThan(5000);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, `failed checks: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
    expect(report.conclusion).toBe("webgpu-viable");
  });
});
