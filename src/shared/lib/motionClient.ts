"use client";

/**
 * Re-export the motion primitives we use so callers have one stable import
 * surface. framer-motion v12 ships a proper `exports` field with `import`
 * (ESM) + `require` (CJS) conditions, so Turbopack now picks ESM for
 * client bundles without the prior `framer-motion-esm` alias workaround.
 */
export {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";
