import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/visual/__screenshots__/{projectName}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // perf measures exclusive GPU/CPU frame time — contention from parallel
      // workers inflates p95 ~2x, so it runs alone in its own project below.
      // Visual baselines live in the dedicated `visual` project.
      testIgnore: ["perf.spec.ts", "visual/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Baselines must be reproducible on any machine and in CI: force software
      // rasterization (SwiftShader) and capture the canvas only, so host GPU,
      // driver and font differences cannot leak into the diff.
      name: "visual",
      testMatch: "visual/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--force-color-profile=srgb",
          ],
        },
      },
    },
    {
      name: "perf",
      dependencies: ["chromium"],
      testMatch: "perf.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort",
    cwd: "../apps/playground",
    url: "http://127.0.0.1:4173",
    // Local Windows host: Playwright's cmd.exe spawn is unreliable — reuse the
    // long-lived playground dev server. CI always spawns its own.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
