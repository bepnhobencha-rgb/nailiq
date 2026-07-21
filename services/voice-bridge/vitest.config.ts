import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The voice bridge is its own package. Without a local config, vitest/vite walk
// up and pick the repo-root config and postcss.config.mjs (Tailwind plugins that
// do not resolve from here). Pin the root and provide an inline empty PostCSS
// config so vite stops searching upward. These are pure Node unit tests — no CSS.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  css: { postcss: { plugins: [] } },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
  },
});
