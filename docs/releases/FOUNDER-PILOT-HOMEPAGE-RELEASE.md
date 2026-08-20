# Founder Pilot Homepage Release

**Branch:** `feat/founder-pilot-multi-pos-homepage`
**Base:** `main` (`eb61c7c` at branch time)
**Type:** Marketing-content rewrite. No migration. No runtime integration change.
**Repository:** https://github.com/bepnhobencha-rgb/nailiq
**Production URL:** https://www.nailiq.ca

## What changed

Landing page (`/`) restructured for the Founder Pilot launch:

- **New positioning** — “More than booking software: NailIQ sets up your salon’s website, booking and operations for you.” Founder Pilot is limited to 5 salons.
- **Multi-POS support (text only, no third-party logos)** — the page reassures owners they can keep Square, Clover, Toast or another POS. NailIQ ships Square connection assistance where currently supported; direct Clover/Toast integrations are explicitly out of scope for the pilot.
- **13 content sections** (see below) replacing the previous 4-tier SaaS pricing / SaaS-generic feature grid.
- **Two Founder Pilot pricing cards** — Monthly ($499 CAD setup + $99 CAD/month, 6-month min) and Annual ($1,399 CAD, setup + 12 months, save $288). No credit-card checkout on the page — every applicant goes through `/contact`.
- **CTAs route to `/contact`** with query params (`?intent=pilot|demo` and `?plan=monthly|annual`). The contact form prefills from those params. `/register` still works for returning-owner sign-in.
- **Bilingual EN + VI** — full new `landing.*` i18n subtree in both `en.ts` and `vi.ts`; `npm run check:i18n` is clean (0 new warnings).
- **Testimonials removed** — no fabricated quotes on the marketing page. If salon quotes are added later, restore `LandingSocialProof.tsx` from git history.
- **SEO** — new page-level title/description; JSON-LD `SoftwareApplication` `offers` updated to `Founder Pilot Monthly` + `Founder Pilot Annual` (was `$39/month`).

## Section order (top → bottom)

1. Hero — Founder Pilot eyebrow, POS reassurance, Apply + Demo CTAs
2. Trust strip — Designed for nail salons · Keep your POS · Vietnamese support · Made in Vancouver
3. Problem — 7 tech pain points + implementation-support conclusion
4. Done-For-You — 7 cards (Website / Booking / Staff / POS workflow / Square setup / Training / Ongoing support)
5. Keep Your POS — Square / Alongside Clover-Toast-other / Custom integration
6. How It Works — 4 steps + 7–14 business-day timeline note
7. Founder Pilot Pricing — Monthly + Annual (BEST VALUE)
8. POS Compatibility — Included / Supported where available / Not included
9. Clear Scope — exhaustive out-of-scope list + $95 CAD/hour additional-support pricing
10. SMS Fair Use — 250 segments/mo cap explained
11. Payment Provider Notice — Square/Clover/Toast independence disclaimer
12. Why Join — pilot benefits + renewal-pricing notice
13. FAQ — 16 questions covering pilot scope
14. Final CTA — Apply / Demo + legal note

## Files changed

**Marketing content (rewritten in place, filenames preserved):**
- `src/app/page.tsx`
- `src/components/landing/LandingHero.tsx`
- `src/components/landing/LandingPainSection.tsx` (now renders `landing.problem`)
- `src/components/landing/LandingFeatures.tsx` (now renders `landing.doneForYou`)
- `src/components/landing/LandingHowItWorks.tsx`
- `src/components/landing/LandingTrustStrip.tsx`
- `src/components/landing/LandingPricing.tsx`
- `src/components/landing/LandingFAQ.tsx`
- `src/components/landing/LandingFinalCta.tsx`
- `src/components/landing/LandingNavbar.tsx` (nav CTA now `/contact?intent=pilot`)

**New landing components:**
- `src/components/landing/LandingKeepPos.tsx`
- `src/components/landing/LandingPosScope.tsx`
- `src/components/landing/LandingClearScope.tsx`
- `src/components/landing/LandingSmsFairUse.tsx`
- `src/components/landing/LandingPaymentDisclaimer.tsx`
- `src/components/landing/LandingWhyJoin.tsx`

**Deleted:**
- `src/components/landing/LandingSocialProof.tsx` — testimonials removed

**Lead form (additive, no schema change):**
- `src/components/contact/ContactForm.tsx` — POS radio group (Square/Clover/Toast/Other/None), Plan radio (Monthly/Annual/Unsure), intent banner from `?intent=`, plan prefill from `?plan=`. No credentials collected.
- `src/shared/contact/submitContactInquiry.ts` — accepts optional `pos`, `posOther`, `plan`, `intent`; serialises into the outbound email subject/body. Same Resend inbox (`thehuytgvn@gmail.com`), no DB write.

**i18n:**
- `src/shared/i18n/user/en.ts`
- `src/shared/i18n/user/vi.ts`

**SEO:**
- `src/shared/seo/jsonLd.ts` — `SoftwareApplication` description + featureList + offers rewritten.

**Tests:**
- `e2e/landing-funnel.spec.ts` — CTA destination expectations updated (`/register` → `/contact?intent=pilot|demo` for marketing CTAs; `/login` unchanged; `/register` still smoke-tested).
- `e2e/content/copy-check.spec.ts` — pricing structure follow-up (`plans[]` → `monthly` + `annual`).

## Explicitly NOT in scope

- No database migration.
- No new REST API route.
- No booking, OTP, auth, RLS, tenant-isolation or payment-runtime change.
- No new Clover / Toast / other POS connector or integration.
- No Square runtime change (existing supported behaviour untouched).
- No environment-variable or production secret change.
- No third-party logo file added.
- No testimonials fabricated.

## Local verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | 84 errors / 100 warnings — same baseline as `main` (no new errors) |
| `npm run test:unit` | ✅ 101/101 |
| `npm run build` | ✅ Compiled successfully in ~35s |
| `npm run check:i18n` | ✅ 0 errors (13 pre-existing style warnings unchanged) |

**E2E deliberately NOT run locally.** Per `docs/audit/PILOT-READINESS-REPORT.md` §"Vì sao không chạy E2E", NailIQ shares one Supabase project with production and E2E seeds real rows. CI is the DB-level evidence layer. `e2e/landing-funnel.spec.ts` runs against public pages (no DB seeding), so CI will validate the new CTAs there.

## Rollback plan

Zero-database change, so rollback is code-only:

1. Vercel → nailiq project → Deployments → previous READY deploy on `main` → **Instant Rollback**.
2. Or, on `main`: `git revert <merge-commit>` → push → Vercel picks up automatically.

No DB, secret, or third-party service was touched — the previous deploy will run correctly with today’s DB and today’s environment variables.

## Post-deploy verification checklist

Manual, read-only. **Do not submit real leads / OTP / bookings on production.**

- [ ] `https://www.nailiq.ca` returns HTTP 200; hero eyebrow reads "FOUNDER PILOT · LIMITED TO 5 SALONS".
- [ ] Hero secondary "Book a Free Demo" navigates to `/contact?intent=demo`.
- [ ] Pricing shows both Monthly ($499 setup + $99/mo) and Annual ($1,399, "Save $288").
- [ ] "Keep the POS You Already Use" section renders all three cards — Square / Alongside / Custom.
- [ ] FAQ has 16 items, all expand.
- [ ] "Apply for Monthly Pilot" → `/contact?intent=pilot&plan=monthly` prefills the Monthly plan radio.
- [ ] EN/VI language toggle re-renders all new copy.
- [ ] `/register` (returning-owner path) still renders "sign in or sign up" and Google + email inputs.
- [ ] `/dashboard/<slug>` while logged out still redirects to `/login`.
- [ ] Public salon booking page still renders for a known slug.
- [ ] No new NailIQ Error Monitor runtime errors on `/` in the 30 min after go-live.
