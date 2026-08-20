# Testing pipeline

NailIQ's automated QA runs in four layers — each can be invoked locally and is
wired into a dedicated CI job on `main`/PR.

| Layer | Local command | CI job | What it catches |
| --- | --- | --- | --- |
| TypeScript | `npm run typecheck` | `ci.yml → Build & Type Check` | Type drift, missing exports |
| Build | `npm run build` | `ci.yml → Build & Type Check` | Runtime config / route errors that pass tsc |
| i18n & copy lint | `npm run check:i18n` | `e2e.yml → i18n-check` | Missing locale keys, empty strings, common VN typos |
| E2E (Playwright) | `npm run test:e2e` | `e2e.yml → e2e` | Functional behaviour, plus the in-browser copy-leak spec |
| Accessibility | `npm run test:e2e -- e2e/accessibility` | included in `e2e.yml → e2e` | axe-core WCAG 2.0/2.1 AA, alt text, label association, focus order |
| Visual regression | `npm run test:e2e -- e2e/visual` | `e2e.yml → visual-tests` (main only) | Pixel diffs vs. checked-in baselines |

## Running each suite

### Type check + build
```sh
npm run typecheck
npm run build
```

### i18n & copy linter
```sh
npm run check:i18n
```
The script compares `userEn` ↔ `userVi` and the `customerWait` en/vi
pair. It exits non-zero only on **errors** (missing keys, empty strings,
non-string values). Whitespace and possible-typo findings are warnings.

Booking i18n is intentionally English-only and is not compared.

### E2E
```sh
npm run test:e2e                # all specs
npm run test:e2e:ui             # Playwright UI
npm run test:e2e:debug          # step debugger
npm run test:e2e:report         # open last HTML report
```

DB-touching specs require `SUPABASE_SERVICE_ROLE_KEY` to seed test
salons. In CI we run only `e2e/content/` and `e2e/accessibility/` when
the secret is unavailable; everywhere else we run the full suite.

### Accessibility
```sh
npm run test:e2e -- e2e/accessibility
```
Wraps `@axe-core/playwright` with three extra structural checks (alt
text, input labels, focus reachability).

### Visual regression
```sh
npm run test:e2e -- e2e/visual                       # compare vs. baselines
npm run test:e2e -- e2e/visual --update-snapshots    # refresh baselines
```

Baselines live in `e2e/visual/__screenshots__/`. **Always commit
refreshed baselines from CI** rather than local, because pixel-level
output drifts between OS / Chromium / WebKit minor versions. In CI:

> 1. Make the design change.
> 2. Push to a feature branch — the PR's visual diff job is informational.
> 3. After merging, tag the merge commit with `[update-snapshots]` in the
>    commit message. The `visual-tests` job on `main` re-runs with
>    `--update-snapshots` and uploads `updated-snapshots` as an
>    artifact for you to download and commit.

## CI jobs

```
ci.yml
├── build           typecheck → lint → build (dummy supabase env)
└── security        npm audit + secret scan

e2e.yml
├── i18n-check      npm run check:i18n
├── e2e             needs i18n-check; full suite if secrets, otherwise
│                   content + a11y only. Uploads playwright-report
│                   (14-day retention). Posts pass/fail summary.
└── visual-tests    main-branch only. Runs e2e/visual. Honours
                    [update-snapshots] in the commit message. Uploads
                    visual-diffs on failure.
```

## Party Link local testing

Party Link creation (`createPartyLink`) and the `/party/[token]` page
(`loadPartyLinkPage`) both use `createServiceRoleClient()`, which requires
**`SUPABASE_SERVICE_ROLE_KEY`** — a server-only secret that is set on Vercel
but is **not** included in the default local `.env.local` template.

### What breaks without it

| Symptom | Root cause |
|---|---|
| Share box ("Chia sẻ với nhóm") never appears after a group booking | `createPartyLink` fails, returns `{ ok: false, reason: "server_error" }` |
| `/party/<token>` shows a 404-style error page | `loadPartyLinkPage` returns `null` |
| E2E helpers (`seedTestSalon`) fail | Same client, same key |

In both cases the **booking success screen still renders correctly** — only the
Party Link share box is absent. A `console.warn` with an actionable message
is printed to the terminal (non-production only).

### Enabling Party Link locally

1. Open the Supabase Dashboard → your project → **Settings → API**.
2. Copy the **`service_role`** (secret) key.
3. Add it to `.env.local`:
   ```
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...your-service-role-key
   ```
4. Restart the dev server (`npm run dev`).

Party Link will now work end-to-end on `localhost:3000`.

### `.env.example` template

The project should have a `.env.example` file at the repo root.
If it is missing, create it with the following content (no real secrets — use
placeholder values):

```
# ─── NailIQ — environment variable template ──────────────────────────────
# Copy to .env.local and fill in real values.
# .env.local is git-ignored and never committed.

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here

# Required for service-role operations (Party Link, OTP seeding, E2E helpers).
# Without this key, Party Link creation fails silently on localhost.
# Get it: Supabase Dashboard → Project → Settings → API → service_role key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# App URLs
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# OpenAI (required for Voice AI / Lily)
OPENAI_API_KEY=sk-...

# NailIQ Error Monitor (optional in local dev — leave empty to disable)

# Demo / testing mode — NEVER true in production
NEXT_PUBLIC_DEMO_OTP=false

# SEO (optional)
NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=
```

> **Note:** The project's `protect-secrets.sh` hook pattern-matches `.env` in
> Bash commands, so `cp .env.example .env.local` must be run outside the Claude
> session (regular terminal is fine).

---

## Adding a new test

- **Functional?** Drop a `*.spec.ts` next to the closest existing spec.
  `e2e/receptionist-center/` has the deepest patterns to copy from.
- **Cross-cutting copy/i18n?** Add the page to `e2e/content/copy-check.spec.ts`.
- **New surface?** Add it to *both* `e2e/visual/visual-regression.spec.ts`
  and `e2e/accessibility/a11y.spec.ts`.

When in doubt: write the test, run it locally with
`npm run test:e2e -- <relative-path>`, watch it fail first, then make
it pass.
