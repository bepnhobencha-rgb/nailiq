# Party Booking Demo Script

**Duration:** ~3 minutes  
**URL:** `http://localhost:3000/liam-nails` (or prod salon)  
**Prereqs:** At least 2 active services, 2+ staff, open availability on a near-future date.

---

## Scene 1 — Customer books a group (Web, ~60 s)

> **Narrator:** "A customer wants to book a group manicure for herself and two friends."

1. Open `http://localhost:3000/liam-nails`.
2. Select a service (e.g. **Manicure**).
3. Choose **Book for a group** (the toggle that appears after service selection).
4. Set **3 people**.
5. Pick an available date and time slot.
6. Fill in organizer details → click **Confirm group booking**.
7. **Show the booking confirmation screen.**  
   Point out: *"Three slots are created — the organiser's name is not copied to all bookings. Each slot starts as 'Guest 1', 'Guest 2', 'Guest 3' — the guests fill in their own details."*
8. A **Party Link** appears (`nailiq.ca/party/<token>`). Copy it.

---

## Scene 2 — Guests claim their slots (Party Link page, ~60 s)

> **Narrator:** "The organiser shares the link in the group chat. Each friend taps it and claims their slot."

1. Open the party link in the browser.
2. **Show the page:** service name, staff name, time — no names filled yet.
3. Tap **This is me** on the first slot.
4. Enter a name (e.g. **Sarah**) + phone + leave reminder checked.
5. Tap **Confirm my slot** — the slot header updates to **✓ Sarah** in real time.
6. *"Sarah can now edit her details or request a change — without leaving the page."*
7. Click **✏️ Edit my details** → change name to **Sarah T.** → **Save changes** → "Details updated!" ✓
8. Click **💬 Need to change something?** → select **Request service change** → type a note → **Submit request** → "Your request has been sent to the salon." ✓

---

## Scene 3 — Receptionist sees it all on the dashboard (60 s)

> **Narrator:** "Back at the salon, the receptionist opens the dashboard."

1. Open `http://localhost:3000/dashboard/liam-nails/center`.
2. **Party Card panel** at the top of the page — show the card for today's group.
3. Point out:
   - **Date + time range** of the group.
   - **"Arrive together" / "Finish together"** badge.
   - **Progress bar**: "1/3 confirmed".
   - **Amber badge**: "1 change requested" (from Scene 2 step 8).
4. Expand the slot list — show:
   - **Sarah T.** — Confirmed ✓
   - **Guest 2** — Pending
   - **Guest 3** — Pending
5. Click **Copy party link** — button flashes "✓ Copied!".

---

## Key talking points

| Feature | What to say |
|---|---|
| Guest placeholders | Slots start as "Guest N" — no one's info is copied without consent. |
| Real-time claim | The moment a guest claims, the name updates everywhere — booking grid and party card. |
| Edit after claim | Guests aren't locked in. Name and phone can be updated any time the link is valid. |
| Change requests | Guests can message the salon about service or staff preference — no back-and-forth texts. |
| Dashboard badge | Receptionists see pending change requests at a glance — no separate inbox to check. |
| Copy Link | One tap to re-share the link from the dashboard. |

---

## Reset for next demo run

```sql
-- In Supabase SQL editor — delete test data for a clean re-run
DELETE FROM party_link_change_requests
  WHERE party_link_id IN (SELECT id FROM party_links WHERE salon_id = '<your-salon-id>');
DELETE FROM party_link_claims
  WHERE party_link_id IN (SELECT id FROM party_links WHERE salon_id = '<your-salon-id>');
DELETE FROM party_links WHERE salon_id = '<your-salon-id>';
-- bookings can stay unless you want a completely clean slate
```
