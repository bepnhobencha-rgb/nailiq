# NailIQ — User Mental Models (Dashboard)

**Role:** Explain how each **membership role** *interprets* the dashboard—not what pixels they see, but the **thinking patterns** that make the interface feel obvious or opaque.  
**Audience:** Product, design, and anyone building or reviewing UI (including AI-assisted generation).  
**Scope:** Receptionist Center shell, owner-oriented desk overlays, and nail-tech consumption of schedule truth.  
**Out of scope:** Implementation, visual tokens, motion, component APIs, and enumerations of product features.

**Alignment:** Carries the operational contract of `docs/UX_PRINCIPLES.md`, the spatial contract of `docs/DASHBOARD_LAYOUT_RULES.md`, lifecycle meaning from `docs/STATE_MACHINE.md`, and authority boundaries from `docs/PERMISSION_MATRIX.md`—as *interpretive* guidance, not as a duplicate spec.

---

## 1. Why mental models matter

A **learned** interface asks the user to memorize where things live, what order to tap, and which mode they are in. Training compensates for mismatch between the system’s model and the user’s model. Every exception becomes a procedure.

An **understood** interface matches how people already think about the job: time as a line, people as rows, intake as a lane, money as a pulse. Recognition replaces recall. The same screen supports a new hire and a veteran because the **geometry of meaning** stays stable.

**Mental model alignment** shortens onboarding because staff are not mapping an abstract product onto the floor—they are mapping the floor onto a surface that already resembles it. Fewer “where do I…?” questions, fewer wrong-row mistakes under pressure, less supervisor shadowing for basic throughput. The product earns trust when it **externalizes** what used to live in someone’s head (who is next, what is late, what is still promised).

---

## 2. Receptionist mental model

### How the floor maps to the screen

- **Timeline = source of truth** — “What is actually committed, when, and with whom” lives in the center grid. If the timeline and reality disagree, the desk fixes the timeline; the timeline is the shared picture the whole team acts on.
- **Queue = incoming pressure** — The right lane is not a second schedule; it is **intake and tension**: who still needs motion, who is waiting for a chair or a name to be called. It answers “what will blow up next if nobody moves it.”
- **NOW line = operational focus point** — The current moment cuts across staff rows. It tells the desk “what should already be happening” vs “what is still in the future.” It is the anchor for check-in drama, late risk, and “do we have time for this walk-in.”
- **Left → past / waiting (identity & row truth)** — Staff names fix **who owns each horizontal band**. The left edge is the roster key; it does not scroll away with the day so the eye never loses “which row is whose.”
- **Center → active zone** — The grid is where duration, overlap, and sequence are **visible at once**. This is where the receptionist proves there is room before they promise it.
- **Right → future / incoming (as pressure, not as clock)** — In the mental model, the right zone is “still to be resolved”: waiters, quick adds, things that are not yet locked into a satisfied block—or are about to collide with one.

*(Reading direction follows the product’s LTR desk layout; RTL locales mirror the roles, not the philosophy.)*

### What they look at first

1. **NOW** relative to the next few blocks—are we on time, slipping, or about to collide.  
2. **Queue depth** — is intake quiet or stacking.  
3. **Staff rows that matter this minute** — who is in service, who has a gap, who has the next hard start.

They do not start with settings, summaries, or secondary bands unless the day is already calm.

### What triggers action

- A **gap** that should not exist, a **overlap** that should not exist, or a block that says the wrong lifecycle stage for what the lobby reports.  
- **Queue motion**: someone has been waiting “too long” by gut or by hinted wait cues.  
- **Customer at the desk** — the physical world preempts scrolling; intake and check-in shortcuts must stay mentally **one gesture away** from the grid.

### What causes stress (and how the UI must reduce it)

- **Ambiguity** — same client name on two rows, unsure which booking is authoritative, unsure whether state matches the lobby. Stress drops when lifecycle labels and valid next moves are visible and **one story** matches the timeline.  
- **Disappearing context** — if the queue or roster vanishes mentally because layout jumped, stress spikes. Stability of the three-zone **jobs** beats denser chrome.  
- **Silent failure** — taps that do nothing, saves that waffle, overlaps that linger. Operational trust requires explicit outcomes (aligned with governance: one authoritative booking state at a time, transitions that make sense).

### What “done” looks like

- **Lobby matches grid** — arrivals, waits, seating, completion all reflected without cognitive translation.  
- **No unattended pressure** — queue drained or honestly scheduled; no phantom “somewhere.”  
- **No surprise collisions** — the day ends with the timeline telling the truth for tomorrow’s setup and handoff.

### How they think about time

Time is **slotted obligation**, not abstract clock reading. They think in **buffers** (can wedging happen?), **sequencing** (who must finish before whom), and **slip** (late flag as “we are drifting,” not moral judgment). Historical and future dates are different jobs; “today” is live choreography.

### How they think about staff load

Each row is a **capacity storyline**: occupied vs available vs about to turnover. Load is **simultaneous**—who is double-booked in practice, who is carrying two narratives (service + late), who needs protection from another intake before they finish. They do not think “utilization percentages” at the desk; they think **can this human take the next obligation without betrayal**.

---

## 3. Owner mental model

### How they read the salon through the dashboard

- **Revenue = health signal** — Not greed display: **confirmation** that commitments turned into closure. Owners scan for drift between busy-ness and yield.  
- **Bottlenecks = staff/time problems** — Persistent gaps in the wrong places, clustering of waits, recurring late overlays—these read as **process or staffing hypotheses**, not as blame on one pixel.  
- **Staff load = efficiency** — They abstract rows into **patterns**: who carries peak, who is idle at the wrong times, whether the roster matches demand shape.  
- **Peak hours = planning data** — Crowding in the grid is a **shape** they remember across weeks; it informs hours, breaks, and hiring conversations.  
- **VIP flow = retention signal** — When surfaced, priority clients are read as **relationship continuity**, not as decoration—who must not slip through cracks.

### What they look at first

A **today snapshot**: is the shop within tolerance—money pulse, chaos pulse, imminent risk. Only then drills: specific staff rows, specific conflicts, trends if they came for analytics.

### What questions they come to answer

- “Are we **okay right now**?”  
- “Are we **okay this week** revenue and utilization-wise?”  
- “Where does it **hurt**—who, what window, recurring or one-off?”  
- “What **policy or roster** change would remove that hurt?”  

They rarely come to admire software; they come to **dispel uncertainty** fast.

### How long they typically spend on the dashboard

**Short bursts** between tasks—often minutes, occasionally longer when investigating a pattern. The mental model favors **three glances**: health, bottleneck locus, action path. Depth is voluntary; skim is default.

### What a “good day” looks like

- Timeline and queue tell a coherent story **without heroic intervention**.  
- Revenue signal matches felt busyness (no mysterious emptiness when the floor was slammed).  
- Staff load follows the day’s shape **without burnout pockets** the owner could have seen coming.  
- VIP or loyalty signals—when in play—show **deliberate care**, not accidents.

*(Seniors overlap reception mental model at the desk; owners add **business entitlement** summaries and broader permission to fix configuration—they still benefit when owner overlays **echo** desk reality in the same terms.)*

---

## 4. Nail tech mental model

### How the chair meets the grid

- **Their own column (row) = their world** — Everything else is context noise unless they choose to widen attention. Identity is anchored to **one horizontal story**: who is in front of them, who is next in that lane.  
- **Next booking = next task** — The mental todo is sequential within the lane: finish current, pivot to successor, watch for overrun. Multi-staff juggling is reception’s cognitive load first.  
- **Break = protected time** — When the schedule says break, that block is **not soft suggestion**; it is the only language the system has for “do not put a body here.” Confusing break with empty sellable space is a trust break.

### What they care about

- **Who, what, how long** for the current and upcoming commitment.  
- **Where they are in lifecycle**—have we started, are we late, are we done (read-only awareness for many actions).  
- **Certainty** — they need to trust that what they see is what reception will enforce; mixed messages between lobby and grid erode confidence.

### What they must never be confused by

- **Two truths** for the same slot or two stories about who is “on” them.  
- Destructive or calendar-defacing affordances **they cannot take** appearing as reachable (hopeful taps that punish). Authority clarity is calming.  
- **Another tech’s urgency** drowning their lane cues—ambient awareness is fine; obligation must stay row-local.

### Minimal interaction model

**Read-mostly choreography**: glance to confirm next, optionally advance **their own** in-chair flow where policy allows—without becoming a substitute receptionist. Input is minimal **by design**: hands are busy; mental bandwidth is scarce; mistakes must not fall upstream on colleagues.

---

## 5. Spatial memory rules

Layout is **muscle memory** for the salon: under noise and interruption, brain uses position before text.

- **Queue is always right** — Intake pressure, ordering, forward motion of “still unresolved” lives in the east lane mentally. Breaking that fractures triage reflexes.
- **Staff is always left** — Rows labels stay **fixed** relative to scrolling time so “who” never detaches from “when.”
- **Actions for a booking live in the drawer** — Detail, mutation, and explanation cluster in one lateral depth surface tied to selection—**not scattered** across the grid as conflicting entry points for the same object.
- **Confirmations settle at the bottom of the drawer** — Destruction and irrevocable commits anchor **low**, after context has been scanned top-to-bottom—the hand path and reading path stay aligned even when adrenaline is high.

**Never move these. Ever.** Preset changes may vary density or optional satellites; they must not **swap roles** among zones or migrate primary booking operations to new homes without forcing retraining for the entire floor cognitive map.

---

## 6. Cognitive load rules

### Maximum information density per zone

- **Left (staff): identity first** — names and row state dominate; garnish competes at the cost of wrong-row taps.  
- **Center (timeline): sequencing truth first** — who is seated when beats secondary meta inside cells when density tightens.  
- **Right (queue): pressure first** — who waits and what must move beats narrative notes.

Overload in any zone steals **interruption recovery** speed.

### When to hide vs show

- **Hide** what is **invalid context**—queue semantics on days where intake is meaningless; live NOW pretense off today’s date. Semantic hiding reinforces trust.  
- **Show** anything that prevents **wrong action** — disabled lifecycle controls stay legible per state-machine discipline so guessing stops.  
- **Progressive disclosure**: summary at row/block level **before** expandable detail drawer—peek, then deepen when touching a commitment.

### What causes decision paralysis

- **Too many equal-weight choices** — every action looking primary.  
- **Metric soup** — numbers without answering an immediate question (“so what?”).  
- **Competing overlays** — two surfaces demanding decisions for one object (violates operational depth discipline).  
- **Ambiguous causality** — late, no-show candidate, reschedule residue without readable story strands.

Paralysis lands on reception first; relieve it through **single primary next move** norms and unmistakable grouping.

### Progressive disclosure principles specific to NailIQ

1. **Grid answers “what is true now”; drawer answers “what should I do.”** Don’t punt policy into banners straddling the grid unless it changes floor truth.

2. **Optional modules amplify** satellites (strip above grid, contextual hints on queue)—they **decorate** zones without **re-assigning** them.

3. **Train once, discover later** — first week needs identity + timeline + intake lane + NOW; analytic bands and overlays earn their place once base throughput is embodied.

---

## 7. Onboarding mental model

### What a brand-new receptionist sees first

The **spatial story**: faces on the left, day-hours in the center, waiting on the right, current time slicing the middle. Without training jargon, they can place **clients in space** and distinguish **incoming pressure** from **scheduled backbone**.

### What must be obvious without training

- **Which zone owns which question** — who works here, what time owns what obligation, what must still leave the lobby.  
- **That each booking has lifecycle meaning** labels consistent from grid to drawer—hue never replaces wording.  
- **That tapping a booking opens accountability** depth (drawer)—not scavenger hunts for hidden verbs.  
- **That conflict and duplication are existential risks**, so confirmations and undo feedback are blunt and surfaced—silence reads as breakage.

### What can be discovered over time

- **Preset densities** tuned to rush vs calm.  
- **Optional modules** (summaries, risk hints, heat emphasis) layered once the base map is reflexive.  
- **Shortcuts and rhythm patterns** elders pass on—eventually muscle memory—as long as the **geometry stays stable.**

---

*NailIQ’s dashboard succeeds when roles do not negotiate the UI—they negotiate the day. Interfaces that mirror **floor physics** shorten training and shrink error; interfaces that rearrange meaning force every shift to partially relearn.*
