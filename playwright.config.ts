import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the SpooVault Web3 E2E suite.
 *
 * Wallet automation is provided by Synpress v4 (Playwright + MetaMask). The
 * MetaMask browser cache is built once with `npx synpress e2e/wallet-setup`
 * before `npx playwright test` is executed (see .github/workflows/e2e.yml).
 *
 * A local Anvil node (chain-id 43113) and the freshly deployed `SpooVault`
 * contract must be available, and the app must be built with the env written to
 * `e2e/.env.e2e` by `e2e/scripts/deploy-anvil.mjs`.
 */
export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
