// SOP knowledge base for Coco, the in-admin assistant. This is the "how every
// feature works" source of truth injected into Coco's system prompt. It is
// grounded in the real dashboard routes and the documented operational flows
// (booking lifecycle, Receptionist Center, walk-in queue, no-show handling,
// staff/services/settings). Coco MUST NOT invent steps, routes, or labels that
// are not described here — when unsure, it deep-links to the relevant page so
// the user can act with the real, already-validated buttons.
//
// Route convention: every link is built as /dashboard/<slug>/... where <slug>
// is provided in the LIVE CONTEXT block. Never hardcode a slug here.

export const SOP_KNOWLEDGE = `# NailIQ — How the salon dashboard works (SOP)

All dashboard pages live under /dashboard/<slug>/... — use the salon slug from
the LIVE CONTEXT when building a link.

## Roles (salon_members.role)
- owner — full access: operations, staff, services, settings, reports, billing.
- admin — like owner for day-to-day management (no billing/ownership changes).
- senior — front-desk + can edit/cancel bookings.
- receptionist — front-desk operations: check-in, walk-ins, mark no-show. Cannot
  edit the service/staff catalog or salon settings.
- nail_tech — view-only on the schedule; cannot modify bookings.
If a user's role can't reach an area, tell them to ask the owner/admin — do not
walk them through an action they can't perform.

## A. Owner / Admin home — /dashboard/<slug>
Today's overview: today's bookings, revenue snapshot, things needing attention.
Starting point to jump into Front Desk, Clients, Settings, Reports.

## B. Receptionist Center (Front Desk) — /dashboard/<slug>/center
The live operational board, updated in real time. Three zones:
1. Staff column (left) — each working staff and their availability
   (available / busy / overbooked / offline). Offline = staff status
   inactive/pending.
2. Timeline (middle) — today's appointments on a time grid per staff.
3. Walk-in queue (right) — walk-in guests waiting to be seated.
Use this page to run the day: seat walk-ins, start/finish services, mark
no-shows, see who is free.

### Booking lifecycle (status values)
- pending — booked but not yet confirmed (e.g. Wix-origin or awaiting verify).
- confirmed — confirmed upcoming appointment.
- waiting — a walk-in in the queue, not yet seated.
- in_progress — service currently being performed.
- completed — service finished.
- cancelled — cancelled.
- no_show — the client did not arrive.
Typical flow: confirmed → in_progress → completed. Walk-in flow:
waiting → in_progress → completed.

### Walk-in queue
A walk-in is added to the queue (status waiting) with name, optional phone,
requested service and priority. From the queue you assign/seat them to a staff
member, which moves them to in_progress. The Front Desk has an undo for a
just-assigned walk-in.

### No-shows
When a confirmed client doesn't arrive, mark the booking as no_show from the
Front Desk (owner/admin/senior/receptionist can do this). No-shows feed the
client's no-show history and the no-show risk signal on future bookings.

## C. Public booking page — /<slug>
Customers book themselves through a step-by-step flow: pick service → pick staff
(or "any") → pick date → pick time → enter contact info → verify → confirm.
No-show protection (verification / OTP / deposit, where enabled) happens during
this flow. Completed bookings appear on the Front Desk and calendar.

## D. Calendar / booking list
Day / week / month calendar plus a booking list to review and manage upcoming
and past appointments. Owner/admin/senior can edit and cancel; nail_tech is
view-only.

## E. Clients — /dashboard/<slug>/clients
Customer list and profiles (history, contact, notes, no-show history). Use this
to look someone up before they arrive or to review a regular's preferences.

## F. Staff (catalog) — managed in Settings
Add staff, set their role and which services they can perform (capabilities),
and their status (active = bookable; inactive/pending = offline). A booking can
only be assigned to a staff member who is active and capable of that service.

## G. Services (catalog) — managed in Settings
Each service has a name, duration, buffer time, and price. Duration + buffer is
the total time the slot occupies. Soft-deleted services stop being bookable.

## H. Settings — /dashboard/<slug>/settings
Salon settings hub: brand/profile, contact, opening hours, services, staff,
dashboard modules, and integrations (e.g. AI voice, reviews where enabled).
Opening hours drive what times customers can book.

## I. Setup wizard — /dashboard/<slug>/setup
Guided first-run setup: complete the salon profile, add services, add staff,
and set opening hours. A salon is "ready to take bookings" once it has at least
one service, one active staff member, customized opening hours, and a complete
profile.

## J. Reports — /dashboard/<slug>/reports
Revenue and operational reports (advanced reports are a separate enabled
feature).

## K. Reminders & no-show protection — /dashboard/<slug>/settings (No-Show Protection)
Automated appointment reminders cut no-shows. When enabled, the system sends each
customer a reminder 24 hours and 3 hours before their appointment — by email, and
by text when SMS reminders are on. Each reminder carries Confirm and Reschedule
links (email also has Cancel) so the customer can self-serve: rescheduling frees
the old slot and auto-offers it to the waitlist. Customers can also just reply to
the reminder text — "YES" confirms the appointment, "CANCEL" cancels it (the
booking updates and the freed slot is offered to the waitlist). Per-salon toggles: reminders
on/off, the 24h reminder, the 3h reminder, and SMS reminders (SMS needs the
salon's text/Twilio set up). Delivery status (sent / delivered / failed) shows
live in the Notifications widget on the home dashboard.

Other no-show defenses:
- No-show risk: every booking gets an AI risk score. On the Front Desk grid a
  not-yet-arrived booking flagged high-risk shows an amber warning; a client with
  2+ past no-shows shows a red warning by their name. Use these to confirm the
  booking or take a deposit early.
- Auto no-show: optionally, a confirmed booking that never starts is marked
  no_show automatically a set number of minutes past its start time.
- Win-back: after a no-show, an optional friendly email invites the client to
  rebook.

## L. Group / party booking — public page /<slug>
Customers can book several people at once (a party). They pick the group size, a
service (plus optional staff and add-ons) per guest, a date, and whether the
group should "arrive together" or "finish together"; the system arranges the
slots — using waves for large groups — and can seat the party next to each other
(a heart badge shows on the Front Desk). The organizer gets one confirmation text
for the whole party plus a shareable Party Link so each guest can claim their own
slot. Group booking is a per-salon feature that must be enabled.

## M. Reviews — /dashboard/<slug>/settings (Google review)
When a booking is marked completed, the system can automatically ask that
customer for a Google review, by email and text, linking to the salon's Google
review page. This needs the salon's Google review URL set in Settings and is
available on Pro and higher plans. Each booking is only asked once.

## N. Language
The whole dashboard is bilingual EN/VI; users toggle their own language. Reply
in the language the user is writing in.
`;
