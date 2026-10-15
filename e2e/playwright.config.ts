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
      // workers inflates p95 ~2x, so it runs alone in its own project below
      testIgnore: "perf.spec.ts",
      use: { ...devices["Desktop Chrome"] },
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
