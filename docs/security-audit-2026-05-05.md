# Security audit — 2026-05-05

`npm audit --audit-level=moderate` reports 2 moderate vulnerabilities, both
rooted in a transitive `postcss` dependency reached through `next`. We are
intentionally **not applying any fix** at this time.

## Findings

| Package | Severity | Advisory | Reachable through |
|---|---|---|---|
| `postcss <8.5.10` | moderate | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS via unescaped `</style>` in stringify output | `next` (production dep) |
| `next 9.3.4-canary.0 – 16.3.0-canary.5` | moderate | (transitive flag — depends on vulnerable `postcss`) | direct dep |

## Why we are not fixing

`npm audit fix` (without `--force`) reports no safe path — it would only
"fix" the issue by **downgrading `next` to 9.3.3**, a 7-major-version
regression that would delete the entire App Router, our middleware, and
React 19 support. That is not a fix; it is a regression.

`npm audit fix --force` performs that downgrade. We do not run it.

The advisory itself targets the **PostCSS stringify output path**. nailiq
uses Tailwind v4 + PostCSS at build time only, on developer-controlled
CSS. There is no path where untrusted user input reaches PostCSS's
stringifier. Practical exposure: **none**.

## Re-check schedule

- **Next re-check: 2026-06-05** (one month)
- Trigger: Vercel publishes a `next@16.x` patch release that pulls in a
  newer `postcss` (≥ 8.5.10). Track Next.js release notes for the bump.
- If by 2026-06-05 there is still no upstream patch, escalate: pin a
  patched `postcss` via `package.json` `overrides` and document the
  override here.

## Verification command

```sh
npm audit --audit-level=moderate
```

Expected: 2 moderate vulnerabilities through 2026-06-05 (or until the Next
upstream patch).
