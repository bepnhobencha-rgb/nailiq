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
- senior — front-desk staff.
- receptionist — front-desk staff.
- nail_tech — view-only on the schedule; can see bookings but cannot change them.
**Front-desk booking actions** (start a service, mark complete, mark no-show,
create a desk "+ New appointment", edit/reschedule, cancel, and undo a cancel)
are all available to owner, admin, senior, AND receptionist. nail_tech can only
look. **Salon setup** (services, staff, opening hours, settings, reports) is
owner/admin only; only the owner controls billing and can grant the admin role.
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
The **"+ New appointment"** button (day view) books a phone-in customer: enter
the phone (returning customers auto-fill), pick service → staff → date → an
available time. The date defaults to **today in the salon's timezone** (not the
device's), so a staff member abroad still starts on the salon's today. You cannot
pick a past date, and the time list only shows times still to come — a slot that
has already passed is never offered or bookable (the server rejects it too). It's
created as a confirmed booking with the same conflict checks and confirmation
SMS/email as a public booking — use it when a customer calls in. The separate
"+ Walk-in" button is for same-day in-person guests only.

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
and past appointments. Front-desk roles (owner, admin, senior, receptionist) can
edit and cancel; nail_tech is view-only.

## E. Clients — /dashboard/<slug>/clients
Customer list and profiles (history, contact, notes, no-show history). Use this
to look someone up before they arrive or to review a regular's preferences.

## F. Staff (catalog) — managed in Settings
Add staff, set their role and which services they can perform (capabilities),
and their status (active = bookable; inactive/pending = offline). A booking can
only be assigned to a staff member who is active and capable of that service.

## G. Services (catalog) — managed in Settings
Each service has a name, duration, buffer time, and price. The buffer is a
reset/cleanup gap reserved AFTER the service before the next booking on the same
staff — so a booking's block on the grid = duration + buffer (the buffer shows as
a faint hatched strip at the tail end of the block). The buffer keeps the next
booking from starting too soon, but it does NOT block the last appointment of the
day: only the SERVICE has to finish by closing time — its buffer may run a little
past close (there's no next customer to reset for). So e.g. a 60-min service with
a 5-min buffer at a salon that closes at 7:00 PM can still start at 6:00 PM.
Soft-deleted services stop being bookable.

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

## N. Language (EN / VI)
The whole dashboard is bilingual. Each person picks their OWN language — it is a
per-user setting (saved in their browser), so changing it does NOT affect other
staff. Two ways:
1) Manually: the **EN / VI** pill in the top-right of the header — tap **VI** for
   Vietnamese, **EN** for English. It switches instantly, no reload.
2) One-tap from you (PREFERRED — actually does it, don't just describe): give a
   deep-link to the page they're on with \`?setLang=vi\` (or \`?setLang=en\`)
   appended. Tapping it switches the dashboard language immediately. Example for
   Vietnamese: [Chuyển sang tiếng Việt](/dashboard/SLUG/center?setLang=vi) — use
   the real slug and a page the user's role can reach. Always offer this link
   when someone asks how to change language; never guess menu paths.

Reply in the language the user is writing in.
`;
