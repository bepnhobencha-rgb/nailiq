# Superadmin users hydration regression

Renders the real Superadmin Users server page and UserListTable with only
`loadAllUsers` and `requireSuperadminPage` replaced by inert local fixtures.
No account, database, or provider connection is required. The production app
never imports this fixture configuration. It does not test real authorization.
Every browser request is limited to GET on the loopback fixture origin.

Run from the repository root:

```sh
npx next build qa/users-hydration --webpack
npx playwright test -c qa/users-hydration/playwright.config.ts
npx vitest run src/shared/superadmin/__tests__/userListPresentation.spec.ts
```

12 browser cases: Chromium and WebKit iPhone 13 × Los Angeles and Tokyo ×
client clock skew +90 seconds, -90 seconds, and +1 day. Each compares actual SSR
cells to hydrated cells after search/sort interactions, checks Live/Today/Week
boundaries, missing and old dates, and rejects console/page errors. Time labels
remain the server-read snapshot until the next server read, like the page's
summary cards. Absolute dates retain the existing server locale convention.

The baseline on e5d798d0 fails in WebKit: relative labels cross minute/day/week
boundaries between SSR and hydration. The test retains the same SSR equality
assertion after the fix. This is isolated rendering proof, not hosted Auth,
real user-data reads, Preview, or Production certification.
