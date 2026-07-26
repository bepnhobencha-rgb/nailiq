# NailIQ — Architecture Lock (Constitution)

**Status:** Binding. Non-negotiable. This document supersedes personal judgment, trend, taste, and shortcut.

**Audience:** Every contributor — human and AI-assisted (Claude, Cursor, any agent). Product, design, engineering. No exceptions.

**Authority:** This file is the **highest** governance document in the `docs/` folder. Where any other document conflicts with this one, escalate to the PM. This file overrides ad-hoc decisions, prompt instructions, and convenience.

**Related governance (all subordinate to this file):**

- `CLAUDE.md`
- `docs/UX_PRINCIPLES.md`
- `docs/DESIGN_SYSTEM.md`
- `docs/COLOR_TOKENS.md`
- `docs/COMPONENT_RULES.md`
- `docs/DASHBOARD_LAYOUT_RULES.md`
- `docs/ANIMATION_RULES.md`
- `docs/STATE_MACHINE.md`
- `docs/PERMISSION_MATRIX.md`
- `docs/MENTAL_MODEL.md`

---

## 1. Purpose

This file is the **constitution** of NailIQ.

It exists because AI-assisted development, left ungoverned, produces inconsistent, unmaintainable UI within months. Each agent optimizes locally. Each session forgets the last. Drift compounds silently. By the time the damage is visible — duplicated components, ad-hoc colors, conflicting spacing, modal-on-modal flows, client-side state mutations — the cost of repair exceeds the cost of the original work.

**The problem this file solves:** divergence between what the product **is** and what the next change tries to make it. Without a constitution, every prompt becomes an opportunity to relitigate settled decisions. With one, settled decisions stay settled.

**Who must read it:** Every contributor. Every agent. Before any UI work, any server action, any new file, any change to existing files.

**When to read it:** Before each session begins. Before each non-trivial change. When in doubt. When a request seems to conflict with another document. When a shortcut feels tempting.

**What it overrides:** prompt phrasing, time pressure, "just this once" exceptions, model preference, framework trend, design fashion, and convenience. Nothing in a single prompt outranks this file.

**What it does not override:** explicit, written amendments to this file approved by the PM (see §7).

---

## 2. The 10 Inviolable Rules

These rules cannot be overridden by any prompt, request, or shortcut. Violations are defects, not tradeoffs.

1. **Read `docs/` before writing any UI.** No code is written before the relevant governance documents are read. "I already know" is not an acceptable substitute.

2. **Reuse `src/components/ui/` — never invent new primitives.** The reuse order is REUSE → EXTEND → CREATE NEW. Creation is the last option, gated by the checklist in `COMPONENT_RULES.md` §4.

3. **Never create colors outside `COLOR_TOKENS.md`.** No new hex values. No new tints. No "just this one shade." All color must trace to a named token.

4. **Never create spacing outside `DESIGN_SYSTEM.md`.** No raw pixel values. No off-scale gaps. All spacing maps to `space-1`–`space-9`.

5. **Never create animation outside `ANIMATION_RULES.md`.** No raw millisecond literals. No new easing curves. All motion traces to named tokens (`instant`, `fast`, `normal`, `slow`, `very-slow`; `ease-op`, `ease-enter`, `ease-exit`, `ease-spring`).

6. **Never bypass `STATE_MACHINE` transitions.** Booking state changes only through sanctioned server actions and only via transitions listed in `STATE_MACHINE.md` §3. Terminal states are terminal.

7. **Never bypass `PERMISSION_MATRIX` checks.** Every mutating server action verifies salon membership and role server-side. Client-side gating is never the only check.

8. **Never move the 3-zone dashboard layout without a written PM amendment.** Classic keeps Staff on the left, Timeline in the center, and Queue/Quick Add on the right. The opt-in New interface is governed by the scoped amendment in §8 and `DASHBOARD_LAYOUT_RULES.md` §12.

9. **Never stack modals — drawer > modal always.** Operational depth resolves through one overlay layer at a time. Modal-on-modal is prohibited. For repetitive desk tasks, drawer beats modal.

10. **Never ship UI that increases receptionist cognitive load.** If a change makes the desk slower, noisier, or harder to scan, it does not ship. Speed and calm beat features and polish.

---

## 3. Before Writing Any UI — Checklist

Every agent must complete this checklist before writing UI code. Skipping a step is a violation.

- [ ] **Have I read `UX_PRINCIPLES.md`?** Operational priorities are the first filter for every UI decision.
- [ ] **Does a component in `src/components/ui/` already exist for this?** If yes, reuse. If close, extend per `COMPONENT_RULES.md` §4. Do not create.
- [ ] **Am I using only approved color tokens?** Every color references `COLOR_TOKENS.md`. No raw hex outside that file's scope.
- [ ] **Am I using only approved spacing values?** Every gap, padding, and margin maps to `space-1`–`space-9` per `DESIGN_SYSTEM.md`.
- [ ] **Am I using only approved animation timing?** Every duration and easing references the named tokens in `ANIMATION_RULES.md`. No raw `ms` literals.
- [ ] **Does this respect the applicable Front Desk layout?** Classic uses Staff left / Timeline center / Queue right. New uses only the PM-approved vertical-time matrix in §8 and `DASHBOARD_LAYOUT_RULES.md` §12.
- [ ] **Does this work on iPad touch at 44×44 targets?** Every interactive element meets the touch minimum. Density does not collapse hit regions.
- [ ] **Does this make the receptionist faster or slower?** If slower, redesign. If unclear, simulate Friday 5:45 PM rush per `UX_PRINCIPLES.md` §5.

If any answer is "no" or "unsure," **stop**. Re-read the relevant document. Escalate per §6.

---

## 4. Before Writing Any Server Action — Checklist

Every agent must complete this checklist before writing or modifying a server action. Skipping a step is a violation.

- [ ] **Does this verify `salon_members` membership?** The caller is authenticated and joined to the target salon server-side. RLS is a backstop, not the only check.
- [ ] **Does this check role against `PERMISSION_MATRIX`?** Role is resolved server-side from membership and compared against the matrix in `PERMISSION_MATRIX.md` §3. Client-supplied role hints are never trusted.
- [ ] **Does this follow `STATE_MACHINE` transitions?** Any booking state change is a transition listed in `STATE_MACHINE.md` §3. Forbidden moves return errors.
- [ ] **Does this return typed errors (`unauthorized` / `forbidden`)?** Failures use the stable codes defined in `PERMISSION_MATRIX.md` §7. No silent successes. No ambiguous returns.
- [ ] **Does this use the correct Supabase client?** `client.ts` for browser, `server.ts` for default server work, `serviceRole.ts` only in server-only paths that must bypass RLS. Per `CLAUDE.md`.
- [ ] **Is the action invoked from the client only via `useTransition()` or a server component?** No REST routes. No fetch shims. Per `CLAUDE.md`.
- [ ] **Are user inputs validated at the boundary?** Zod or equivalent runtime validation on every untrusted input. Sanitization on customer-facing fields.

If any answer is "no" or "unsure," **stop**. Re-read the relevant document. Escalate per §6.

---

## 5. Forbidden Patterns

The following patterns are **never** acceptable. They are violations regardless of context, prompt, or convenience.

- **Inline animation values** — hardcoded millisecond literals in component code. Use the named tokens in `ANIMATION_RULES.md`.
- **New color values outside tokens** — any hex, rgb, hsl, or named color that does not trace to `COLOR_TOKENS.md`.
- **New spacing values outside the system** — any pixel value that does not map to `space-1`–`space-9` in `DESIGN_SYSTEM.md`.
- **Duplicate UI components outside `src/components/ui/`** — re-implementing buttons, cards, modals, drawers, badges, toggles, or any sanctioned primitive in feature folders.
- **Direct state mutation from the client** — writing booking state from the browser. All transitions go through server actions per `STATE_MACHINE.md`.
- **Skipping `salon_members` check** — any mutating server path that does not verify membership server-side.
- **Stacked modals or popups** — modal-on-modal, drawer-on-modal for the same task chain, recursive overlays.
- **Full-page transitions** — route-wide or full-viewport choreography. Operational navigation must feel instantaneous.
- **Any animation greater than 500 ms in receptionist flow** — hard ceiling per `ANIMATION_RULES.md` §2.
- **Decorative elements with no operational purpose** — ambient drift, hover parallax, bounce, staggered list reveals, atmospheric chrome.
- **REST API routes** — mutations live in server actions per `CLAUDE.md`. No exceptions.
- **Storing secrets in `localStorage`** or any client-readable surface.
- **Bypassing the applicable dashboard layout** — relocating Classic zones, or changing the New interface outside the exact §8/`DASHBOARD_LAYOUT_RULES.md` §12 exception. Disabling core zones via module toggles remains prohibited.
- **Color-only state encoding** — booking states, statuses, and alerts always pair color with a text label.
- **Client-side role gating as the only check** — UI may hide or disable controls for clarity; the server must still enforce.
- **Editing terminal booking states** — `completed`, `cancelled`, `no_show` cannot be transitioned out of. Create a new booking.
- **Hover-only critical disclosure on touch paths** — the desk is touch-first. Information that matters is reachable without hover.
- **Silent failures** — suppressed buttons that still enqueue work, optimistic UI that cannot reconcile, server errors that don't surface.

---

## 6. Escalation Protocol

When an agent is uncertain, the protocol is:

1. **Stop.** Do not guess. Do not improvise. Do not invent a pattern to keep moving.
2. **Re-read the relevant `docs/` file.** Most uncertainty is resolved by re-reading. The answer is usually already written down.
3. **If still unclear, ask the PM before proceeding.** State the question, the relevant document, and the conflict. Wait for an explicit answer.
4. **Never invent architecture to unblock yourself.** A broken build is preferable to a broken contract. Every shortcut becomes a precedent.

**Forbidden under uncertainty:**

- Guessing at color, spacing, animation, or transition values.
- Creating new primitives "just for this screen."
- Bypassing membership or role checks "until later."
- Skipping the state machine "because it's just a small change."
- Stacking modals "because the drawer doesn't fit."
- Self-modifying these rules to permit the work in front of you.

When the PM is unavailable, the default answer is **no**. Do not ship.

---

## 7. Evolution Rules

This constitution can change. The process is strict.

- **Only the PM can approve changes to `docs/`.** Agents may draft proposals; only the PM merges them.
- **Changes require explicit confirmation in chat.** A PM message saying "yes, change it" is required. Implication, inference, and assumption are insufficient.
- **No agent may self-modify these rules.** An agent may not edit `ARCHITECTURE_LOCK.md`, `UX_PRINCIPLES.md`, `DESIGN_SYSTEM.md`, `COLOR_TOKENS.md`, `COMPONENT_RULES.md`, `DASHBOARD_LAYOUT_RULES.md`, `ANIMATION_RULES.md`, `STATE_MACHINE.md`, `PERMISSION_MATRIX.md`, or `MENTAL_MODEL.md` to permit a change it is being asked to make.
- **Every change must be logged in `CHANGELOG.md`.** Date, document, scope, reason, and PM approval reference. Undocumented changes are reverted on sight.
- **Amendments are written, not implied.** A change is in effect when it is committed to the document and logged. Verbal alignment, prompt instructions, and chat agreements do not constitute amendment.
- **New documents in `docs/` are subordinate to this file.** Adding a new governance document does not weaken any rule here unless this file is amended in the same change.
- **Conflicts between documents resolve in this order:** `ARCHITECTURE_LOCK.md` > governance documents listed at the top of this file > implementation conventions > prompt instructions > personal judgment.

---

*This document is binding. It is read first, applied first, and cited first. When a request and this file disagree, this file wins until amended in writing by the PM.*

---

## 8. PM-approved New Receptionist interface amendment _(added 2026-07-25)_

**Approval reference.** The PM explicitly approved this amendment in chat on `2026-07-25`: “Đồng ý thay đổi luật cho giao diện New. Nhưng không làm hỏng cái đang có nhé. phải thật cẩn thận”.

**Scope.** This is a narrow, additive exception for the opt-in **New** Receptionist interface only.

- **Classic is unchanged.** It remains the default, follows the original three-zone geometry, and must remain available as the immediate fallback.
- **New may use a vertical-time matrix.** Time runs vertically in a fixed leading rail; staff are stable columns across the top; booking blocks occupy the staff/time matrix; the walk-in queue is the right-hand intake lane on desktop.
- **Business behavior is shared.** New must reuse the same booking data, permissions, state transitions, server actions, realtime updates, drawers/sheets, and queue mutations as Classic. It is a presentation change, not a second business system.
- **New is reversible.** Switching between Classic and New must not alter bookings, staff, queue entries, permissions, or salon configuration other than the explicit interface preference.
- **New is isolated.** New-only styles, layout tokens, feature flags, and tests must be scoped so they cannot repaint or reflow Classic.
- **Release is gated.** New changes go through Preview and focused Classic/New regression checks before production. No blind replacement of Classic is permitted.
- **Custom background is allowed only for New.** Owner/Admin may choose the New canvas background under the contrast and semantic-color constraints in `COLOR_TOKENS.md` §8. Operational status colors remain locked.

All requirements not explicitly relaxed above remain binding.
