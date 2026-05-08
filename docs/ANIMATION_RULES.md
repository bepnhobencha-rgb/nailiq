# NailIQ — Animation Rules

**Role:** Motion contract for production software.  
**Audience:** Product, design, engineering.  
**Scope:** When, how long, and how UI may move. **Principles and named tokens only**—no implementation patterns beyond the contract in §6.

**Alignment:** Subordinate to `docs/UX_PRINCIPLES.md` and `docs/DESIGN_SYSTEM.md`. Motion must never contradict receptionist-first, low-cognitive-load, or accessibility baselines.

**Product context:** NailIQ is **operational software** used under pressure—rush hour, noise, multitasking, and social cost when something goes wrong. Animation exists to **aid comprehension and feedback**, not to impress.

**Golden rule:** If removing an animation makes the UI **faster or clearer**, remove it.

---

## 1. Motion philosophy

**Restraint is the default.** The desk is judged on throughput, correctness, and calm—not on how “alive” the interface feels. Every millisecond of motion is a tax on attention and reaction time; only spend that tax when the motion **explains** something (where a surface came from, that work is in progress, that state changed).

**Animation is feedback, not decoration.** Allowed motion answers questions: *What just happened? Where did that panel go? Is the system working?* Motion that only adds atmosphere, brand personality, or delight without reducing error or confusion is out of scope for operational paths.

**Operational context:** Receptionists work in **rush conditions**—standing, touching, glancing between clients and screen. Stress amplifies sensitivity to lag, ambiguity, and visual noise. Motion must be **short, predictable, and low-noise** so it never competes with scanning the queue, timeline, or booking detail. Under load, the product should feel **immediate**; motion must not read as hesitation or theater.

---

## 2. Timing system

All motion **duration** in product code must map to one of the named values below. Do not invent ad hoc lengths for interactive transitions.

| Name        | Duration | Role |
| ----------- | --------: | ---- |
| `instant`   | **0 ms** | State changes with **no** transition (toggle, instant swap, reduced-motion fallbacks). |
| `fast`      | **100 ms** | Micro-interactions (small affordances, tight feedback). |
| `normal`    | **200 ms** | Standard transitions (most cross-fades, light position changes). |
| `slow`      | **350 ms** | Drawers, modals, and other **large** surfaces entering or leaving. |
| `very-slow` | **500 ms** | **Only** onboarding, empty states, or non-blocking educational moments—**never** core receptionist flow. |

**Ceiling:** No animation in the **receptionist flow** may exceed **500 ms** total; prefer `fast`–`slow` for anything time-critical (see §4).

**Easing** names describe **intent**; implementations must use curves that match that intent (e.g. cubic-bezier or spring parameters—defined in the shared motion module, not duplicated per feature).

| Name           | Intent |
| -------------- | ------ |
| `ease-op`      | **Operational default:** motion **settles quickly** and feels responsive—use an **ease-out** family (fast start, gentle finish). Default for most UI transitions. |
| `ease-enter`   | Elements **entering** the viewport or a container: slightly soft arrival; still short and readable—avoid long ease-in-only curves that feel sluggish. |
| `ease-exit`    | Elements **leaving:** can accelerate out slightly so the screen clears **without** drawing attention to the exit path. |
| `ease-spring`  | **Subtle** spring for **interactive** feedback (press, small position return). Low overshoot, high stiffness—never bouncy or playful. |

---

## 3. Allowed animations

Only the following categories are **approved** for NailIQ. If a proposed effect is not on this list, treat it as **forbidden** until design and engineering amend this document.

- **Drawer slide-in / slide-out** — Preserves spatial context; enter/exit along one axis; pair with scrim behavior per overlay rules in the design system.
- **Modal fade + scale** — Blocking surfaces: brief opacity change with a **restrained** scale-in (and reverse on exit). No dramatic zoom.
- **Toast slide-in / slide-out** — Transient feedback; short path; must not block primary work longer than the copy requires.
- **Badge pulse (alerts only)** — **Exceptional** attention for **actionable** or **critical** desk signals only; **not** for routine updates.
- **Skeleton shimmer** — Loading placeholders where content structure is known; prefer over indeterminate spinners in operational lists and panes.
- **Status dot transition** — Small state indicators may **cross-fade** or **softly** change; no carnival flashing.
- **NOW line pulse (subtle, not distracting)** — A **low-amplitude**, **slow** periodic cue for temporal anchor only; must remain ignorable at peripheral vision.
- **Tab / preset switch fade** — Switching tabs or presets may use a **short** opacity cross-fade; no sliding page metaphor.

---

## 4. Forbidden animations

The following are **never** allowed in NailIQ as specified.

- **Page transitions (full screen)** — No route-wide or full-viewport choreography; operational navigation must feel instantaneous.
- **Decorative floating elements** — No ambient drift, faux depth, or “living” chrome.
- **Hover parallax** — No layered motion tied to pointer position on operational surfaces.
- **Continuous spinning loaders** — Use **skeleton shimmer** or determinate progress; spinning indicators may not run indefinitely as the primary loading pattern.
- **Bounce effects** — No playful overshoot choreography on widgets, lists, or CTAs.
- **Staggered list animations in operational views** — No cascading delays on queue rows, timeline cells, or booking lists; scanning speed beats choreographed reveals.
- **Any animation greater than 500 ms in receptionist flow** — Hard stop; shorten, split into `instant` state + static affordance, or remove.

---

## 5. Reduced motion rules

- **`prefers-reduced-motion` must be respected.** When the user or OS requests reduced motion, NailIQ must not rely on animation for **essential** information; **no animation must still mean fully functional** software.

**Fallback behavior** for each **allowed** animation:

| Allowed animation            | Reduced-motion behavior |
| ---------------------------- | ----------------------- |
| Drawer slide-in / out        | **Instant** show/hide; optional **single-step** opacity on scrim only if needed for focus—no travel animation. |
| Modal fade + scale           | **Instant** or **minimal** opacity step only; **no** scale. |
| Toast slide-in / out         | **Instant** placement; optional static opacity if required for contrast—no travel. |
| Badge pulse (alerts only)    | **Static** emphasis only (e.g. persistent label/icon treatment per design system)—**no** pulsing loop. |
| Skeleton shimmer             | **Static** skeleton blocks—**no** moving gradient. |
| Status dot transition        | **Instant** state swap or **instant** color/ shape change—no transition duration. |
| NOW line pulse               | **Static** line—no periodic motion. |
| Tab / preset switch fade     | **Instant** swap—no cross-fade duration. |

**Requirement:** Reduced-motion mode must preserve **labels, hierarchy, and focus order**; only **non-essential** motion is removed.

---

## 6. Implementation contract

- **Framer Motion only** for interaction and transition animation in application UI. Do not use **CSS keyframes** for **interactive** motion (enters, exits, taps, drawers, modals, toasts). (Static marketing assets or system-level exceptions are outside this document’s scope—operational product code follows this rule.)

- **All duration and easing** values used for motion must **trace to this document’s named tokens** (`instant`, `fast`, `normal`, `slow`, `very-slow` and `ease-op`, `ease-enter`, `ease-exit`, `ease-spring`) via a **single shared mapping** (e.g. module-level constants). **No raw millisecond literals** in feature components.

- **Animation variants** (Framer Motion `variants` or equivalent structured objects) must be defined **at component level** (module scope or dedicated block in the file)—**not** inline as one-off object literals on every element. Reuse parent/child variant trees where the same pattern repeats.

- **Review gate:** Any new motion category requires updating **this file** first; shipping ad hoc effects without a documented allowance is a contract violation.

---

*Motion is optional; clarity and speed are not. Build for Friday at closing time—not for a keynote.*
