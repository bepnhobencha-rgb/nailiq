// This parent-segment fallback intentionally lives above `[slug]/layout.tsx`.
// The slug layout performs authenticated, request-scoped reads, so the nested
// `[slug]/loading.tsx` cannot render until that layout has finished. Re-export
// the shared dashboard skeleton here to prevent a blank dark screen while the
// authenticated shell is still resolving.
export { default } from "./[slug]/loading";
