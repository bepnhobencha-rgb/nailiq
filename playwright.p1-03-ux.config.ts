import { defineConfig, devices } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: "**/receptionist-center/operator-journey.spec.ts",
  workers: 1,
  projects: [
    {
      name: "desktop-en",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone-se-en",
      use: { ...devices["iPhone SE"] },
    },
    {
      name: "iphone-pro-max-vi",
      use: { ...devices["iPhone 14 Pro Max"] },
    },
    {
      name: "ipad-vi",
      use: { ...devices["iPad Pro 11"] },
    },
  ],
});
