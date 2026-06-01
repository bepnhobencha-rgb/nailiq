# Feature Flags — Base Release

NailIQ ships behind a **release feature registry**: a single source of truth
for which product surfaces belong to the customer-ready **Base** release vs
**Beta** (unfinished / opt-in) work.

- Registry + resolver: [`src/shared/features/featureRegistry.ts`](../src/shared/features/featureRegistry.ts)
- Tests: [`src/shared/features/__tests__/featureRegistry.test.ts`](../src/shared/features/__tests__/featureRegistry.test.ts)
  (run: `npx tsx src/shared/features/__tests__/featureRegistry.test.ts`)

> **Status — PR1 (foundation only).** This PR adds the registry, the resolver,
> and carries the flag inputs into the dashboard context. It does **not** hide
> nav, block routes, or block server actions yet. Those land in later PRs (see
> [Rollout](#rollout)). Adding PR1 changes no runtime behavior.

---

## Release flags vs billing/subscription

These are **two separate concerns** and are intentionally not merged:

| Concern | Question it answers | Lives in |
| --- | --- | --- |
| **Release flag** | Is this surface shipped/enabled for this salon? | `featureRegistry.ts` (`isReleaseFeatureEnabled`) |
| **Billing / plan** | Is this salon's tier allowed to use it? | `@/lib/feature-gating` (`hasFeature`, `PLAN_FEATURES`), `@/shared/lib/subscriptionPlans` |

A feature can be Base-stable yet still sit behind a paid plan. The release
resolver never changes billing logic — for the few features that are
plan-gated today (photos, reviews) it **reads** `hasFeature` read-only.

---

## Feature list & default state

Defaults require **no DB row**: a salon that has set nothing resolves purely
from `defaultOn` (Base → ON, Beta → OFF).

### Base — default **ON**

| Key | Surface | Override source |
| --- | --- | --- |
| `public_booking` | Public booking page `/[slug]` | registry default |
| `receptionist_center` | Front-desk board `/dashboard/[slug]/center` | `feature_flags.receptionist_center_enabled` |
| `basic_mode` | Per-device simplified front desk | registry default |
| `walkin_queue` | Walk-in queue panel | `feature_flags.walkin_queue_enabled` |
| `calendar_booking_list` | Calendar / booking list views | registry default |
| `staff_basic` | Staff roster + roles | registry default |
| `service_basic` | Service catalog + pricing | registry default |
| `customer_basic` | Customer list + basic profiles | registry default |
| `bilingual_en_vi` | EN/VI UI toggle | registry default |
| `basic_settings` | Settings hub | registry default |

### Beta — default **OFF**

| Key | Surface | Override source |
| --- | --- | --- |
| `group_booking` | Group / party booking | `feature_flags.group_booking_enabled` |
| `ai_voice` | AI voice receptionist | column `salons.voice_ai_enabled` |
| `loyalty` | Loyalty / rewards | `feature_flags.loyalty_enabled` |
| `reviews` | Auto review-request | plan feature `reviews` (via `hasFeature`) |
| `photos` | Photo confirmation | plan feature `photo_confirmation` (via `hasFeature`) |
| `marketing` | Marketing / SMS | registry default |
| `combos` | Service combos / bundles | registry default |
| `tv_mode` | Waiting-room TV display | registry default (not yet implemented) |
| `advanced_reports` | Advanced analytics | `feature_flags.reports_enabled` |
| `experimental_realtime` | Experimental realtime widgets | registry default |

**No key duplication.** Where a per-salon toggle already exists, the registry
maps to it rather than minting a new one:
- `feature_flags` keys come from `SUPERADMIN_PER_SALON_FLAGS`
  (`receptionist_center_enabled`, `walkin_queue_enabled`,
  `group_booking_enabled`, `loyalty_enabled`, `reports_enabled`).
- `ai_voice` reuses the dedicated `salons.voice_ai_enabled` column.
- `photos` / `reviews` reuse billing-side `PLAN_FEATURES` keys.

---

## How resolution works

```ts
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";

if (isReleaseFeatureEnabled(salon, "group_booking")) {
  // show / allow the group-booking surface
}
```

Precedence (first decisive wins):

1. **Explicit per-salon override** in the feature's mapped store:
   - `jsonb` → boolean `feature_flags[flagKey]`
   - `column` → boolean `salons.voice_ai_enabled`
   - `plan` → `hasFeature(salon, planFeature)` (which itself honours a
     `feature_flags` override before the plan)
2. **Registry default** (`defaultOn`). No DB row required.

The resolver takes a partial salon shape and degrades gracefully to defaults,
so callers with incomplete context never throw.

---

## How SuperAdmin override works

SuperAdmin already edits per-salon flags at
`/superadmin/salons/[salonId]` via `SalonOverrideCard` →
`updateSalonFlags(...)`, which writes:

- `salons.feature_flags` (JSONB map of booleans) — wins over the release
  default for any `jsonb`-sourced feature.
- `salons.plan_override` — affects billing-side `hasFeature`, hence the
  `plan`-sourced features (photos, reviews).
- `salons.voice_ai_enabled` (column) — the `ai_voice` toggle.

So to force a Beta feature **ON** for one salon, a SuperAdmin sets the mapped
`feature_flags` key to `true` (e.g. `group_booking_enabled: true`); to force a
Base feature **OFF**, set its key to `false`. Every change is audit-logged
(`superadmin_audit_logs`, action `salon_flags_set`).

> Registry-only keys (`public_booking`, `staff_basic`, `combos`, `tv_mode`,
> `marketing`, `experimental_realtime`, `calendar_booking_list`,
> `customer_basic`, `service_basic`, `basic_mode`, `bilingual_en_vi`,
> `basic_settings`) do not yet have a SuperAdmin toggle — they resolve from
> their default. A per-salon store + SuperAdmin UI for them is added in PR4.

---

## Read-only resolved panel (PR4a)

`/superadmin/salons/[salonId]` renders a **read-only** "Release features
(resolved)" card (`SalonReleaseFeaturesCard`) directly under the Overrides
card. It does not add any controls — no toggles, no save, no reset — it only
mirrors what `isReleaseFeatureEnabled` resolves for the salon so an operator
can read the effective state without inferring it from the mutation card.

Each row shows:

- **label / key** — the human label plus the registry key.
- **resolved ON/OFF** — `isReleaseFeatureEnabled(salon, key)`.
- **default ON/OFF** — the registry `defaultOn` (Base → ON, Beta → OFF).
- **source badge** — `jsonb` · `column` · `plan` · `registry` (where the
  resolver read the state from).
- **override badge** — shown when the resolved state diverges from the default
  for this salon (a `feature_flags` key, the voice column, or the plan pushed
  it off the default).

Rows are grouped into **Base**, **Beta**, and **Plan / Column-controlled** —
the last bucket collects features whose state is owned by an external store
(billing `plan` or the `voice_ai_enabled` column) rather than the per-salon
`feature_flags` jsonb. The card also carries the standing reminder that
**release flags control product visibility, not billing**.

The panel is driven by a pure, read-only helper:

```ts
import {
  describeReleaseFeatureForSalon,      // one feature → resolution snapshot
  describeReleaseFeaturesForSalon,     // all features, grouped Base/Beta/Plan-Column
} from "@/shared/features/featureRegistry";

const row = describeReleaseFeatureForSalon(salon, "group_booking");
// { resolved, defaultOn, source, overridden, uiGroup, ... }
```

Both helpers are covered by the registry unit tests
([`src/shared/features/__tests__/featureRegistry.test.ts`](../src/shared/features/__tests__/featureRegistry.test.ts))
and the panel by an e2e spec
([`e2e/superadmin/salon-release-features.spec.ts`](../e2e/superadmin/salon-release-features.spec.ts)).

---

## Rollout

This is delivered as a sequence of small PRs so each layer can be reviewed and
verified independently:

| PR | Scope |
| --- | --- |
| **PR1 (this)** | Registry + resolver + dashboard-context flag inputs + docs + tests. No gating. |
| **PR2** | UI gating — hide sidebar / mobile-nav items when a feature is OFF. |
| **PR3** | Route + server gating — beta routes `notFound()`; `requireFeature` guards server actions / API routes. |
| **PR4a** | SuperAdmin **read-only** resolved panel — `SalonReleaseFeaturesCard` shows resolved/default/source/override per salon, grouped Base/Beta/Plan-Column. No new writes. |
| **PR4b** | SuperAdmin write wiring — surface registry-only keys as editable controls (separate PR). |
| **PR5** | E2E — toggle a Beta flag and assert nav hidden + route 404 + action blocked. |

### Adding a new feature flag

1. Add the key to `BaseFeatureKey` / `BetaFeatureKey` and a descriptor in
   `RELEASE_FEATURES` (`featureRegistry.ts`).
2. Choose a `source`:
   - reuse an existing `feature_flags` key → `{ kind: "jsonb", flagKey }`
     (and confirm it exists in `SUPERADMIN_PER_SALON_FLAGS`),
   - reuse the voice column → `{ kind: "column", column: "voice_ai_enabled" }`,
   - reuse a billing feature → `{ kind: "plan", planFeature }`,
   - otherwise `{ kind: "registry" }` (default-only, SuperAdmin store added later).
3. Set `defaultOn` per phase (Base → true, Beta → false).
4. Update this doc's tables + the registry test counts.
