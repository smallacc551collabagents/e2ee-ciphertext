import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: "pnpm dev", url: "http://localhost:3000/login", reuseExistingServer: true },
});
