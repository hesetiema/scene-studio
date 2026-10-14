import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort",
    cwd: "../playground",
    url: "http://127.0.0.1:4173",
    // On this Windows host Playwright's cmd.exe spawn is unreliable — reuse the
    // long-lived playground dev server started outside the test runner.
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
