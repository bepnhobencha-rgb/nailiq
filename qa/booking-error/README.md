# Booking error recovery fixture

Renders the production BookingFlowErrorBoundary, shared Button, booking copy and
booking theme variables. A synthetic child throws during render; a counter outside
the boundary models a confirmation that already happened. It does not create a
booking or certify any real database/provider outcome. Error reporting is replaced
by an inert local module; all browser traffic is restricted to loopback GET/HEAD.
The production app never imports this fixture or its webpack replacement.

Run from the repository root:

```sh
npx next build qa/booking-error --webpack
npx playwright test -c qa/booking-error/playwright.config.ts
```

16 cases: Chromium and WebKit × 320/1024px × light/dark × English/Vietnamese.
Each checks the fallback after synthetic confirmation, another render failure,
persistent failure containment, keyboard and pointer retry, no extra synthetic
confirmation, no outbound/mutation request, text contrast >= 4.5:1, a touch target
>= 44px and no horizontal overflow. Retrying remounts the form; it does not prove
that unsaved form selections survive. JSON and fallback screenshots are attached.

Baseline a4479afe fails the focused Vietnamese/light cases in both browsers:
English-only copy, a false negative confirmation claim, heading contrast 1.09:1,
body contrast 2.35:1, and a 40px button box. The same assertions pass after the fix.
The previous shared Button had a pseudo-element extending its touch target; the
40px box alone is not proof that the previous effective target was below 44px.

Limits: component rendering, not full public/embed route navigation; languages
are supplied to the fixture using the same copy bundles as the two production
callers. Hosted Auth, real booking commits, providers, CI, Preview, Production
crash frequency and physical iPhone behavior are not certified by this fixture.
