# Expired Trial Policy — decision required before implementation

Last verified: 2026-08-13

Scope: self-service 14-day trial tenants only. This decision does not change
paid salons, private offers, Stripe subscriptions, or either Hi-Lite salon.

## Why this decision is required

The current product shows an expired-trial banner but does not enforce a
tenant-wide entitlement boundary. In particular:

- the Dashboard remains operational after `trial_ends_at`;
- autonomous AI eligibility checks `subscription_status = trialing`, but does
  not inspect `trial_ends_at`;
- public booking is not governed by one canonical expired-trial policy;
- no verified read-only/export contract exists.

Therefore `BILL-015`, `BILL-017`, and `BILL-018` cannot be marked complete from
the current code. A UI banner is not an entitlement control.

## Options

| Option | Customer experience | Cost / operational risk | Recommendation |
| --- | --- | --- | --- |
| A — immediate read-only | At expiry, pause public booking and all mutations; allow sign-in, view, export and subscribe | Lowest cost; abrupt for appointments already booked | Not preferred |
| B — 7-day continuity window | At expiry, pause new public bookings and autonomous/marketing work; allow staff to finish appointments already on the calendar, allow existing transactional reminders, export and subscribe. After day 7, read-only | Protects booked guests without allowing new unpaid demand; moderate implementation complexity | **Recommended** |
| C — banner only | Keep the current behavior until the owner subscribes | Simplest, but paid features, AI cost and new obligations may continue indefinitely | Reject |

## Recommended state contract

### Active trial (`now <= trial_ends_at`)

- Full trial entitlements.
- Public booking available.
- Usage remains subject to published trial quotas.

### Continuity window (`trial_ends_at < now <= trial_ends_at + 7 days`)

- Pause new public booking with a bilingual, salon-branded explanation.
- Block new campaigns, autonomous AI generation, AI Voice sessions, bulk
  outbound, new payment/no-show charges and new staff-created appointments.
- Allow staff to view the calendar and complete/cancel/reschedule appointments
  that were created before expiry.
- Allow only transactional reminders already associated with those existing
  appointments; no marketing or win-back messages.
- Allow Owner/Admin to export salon data and open subscription/plan settings.
- Show one clear next action: subscribe to restore full access.

### Read-only (`now > trial_ends_at + 7 days`)

- Dashboard sign-in remains available.
- Calendar, customers, reports and audit history are view-only.
- Export and subscription/plan settings remain available.
- Public booking, AI, outbound, booking mutations and charges remain paused.
- No automatic data deletion. Retention/deletion follows the separately
  approved privacy and retention policy.

### Reactivation

- Only a verified active subscription restores paid entitlements.
- Reactivation must be idempotent and must not recreate or duplicate
  subscriptions, reminders, bookings or AI jobs.
- Restore access from a single server-side entitlement resolver; do not rely on
  local storage, CSS, route-specific checks or client-only flags.

## Required implementation proof after approval

1. One canonical resolver covers active trial, continuity, read-only, active,
   past-due grace, canceled, archived and superadmin-locked tenants.
2. Server-side tests cover exact boundary instants and invalid/missing dates.
3. Dashboard write APIs, cron/AI workers, booking mutations, public booking,
   outbound and charge routes consume the same decision or a deliberately
   narrower capability derived from it.
4. Authenticated E2E proves allowed and denied actions for each state on a
   throwaway database.
5. Existing appointments are preserved; no trial transition deletes data.
6. Export remains available in read-only mode.
7. Feature-flagged QA rollout is verified before any production tenant.
8. Hi-Lite Head Spa and Hi-Lite Studio receive no flag or state change.

## Owner decisions needed

- [ ] Approve Option B (7-day continuity window).
- [ ] Approve pausing new public bookings immediately at trial expiry.
- [ ] Approve transactional reminders only for pre-expiry appointments during
      the continuity window.
- [ ] Approve read-only export and subscription settings after day 7.
- [ ] Confirm that no data is auto-deleted solely because a trial expired.

No enforcement code should be merged until these decisions are approved.
