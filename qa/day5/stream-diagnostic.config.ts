import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Expected one isolated QA web server");

// Same real journey and safety guards, with QA-only server observation.
export default defineConfig({
  ...base,
  outputDir: "../../test-results/day5-stream-diagnostic",
  reporter: [["list"], ["json", { outputFile: "../../test-results/day5-stream-diagnostic/results.json" }]],
  webServer: {
    ...server,
    command: `"${process.execPath}" --require ./qa/day5/stream-request-correlation.cjs node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3117`,
  },
});
