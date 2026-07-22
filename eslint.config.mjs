import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Supabase generates open-ended index signatures for schema objects. Keep
  // no-explicit-any strict everywhere else; this file is replaced wholesale
  // whenever database types are regenerated.
  {
    files: ["src/lib/database.types.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local Claude Code worktrees (per-task isolated checkouts) duplicate
    // the source tree and were re-scanned, producing dozens of false-positive
    // errors. They are not part of the active codebase.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
