"use client";

/**
 * Turbopack can resolve the main `framer-motion` entry to CommonJS (`require`),
 * which throws `ReferenceError: require is not defined` in the browser.
 * Import the published ESM build directly (same runtime as `import` in package exports).
 */
export {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion-esm";
