# NailIQ — Project Brain

Living document. Update after significant changes so sessions can resume with shared context.

## Vision

NailIQ is the AI-first operating system for nail salons and beauty businesses: one place to run the front door, the chair, the till, and growth.

## Product Positioning

- **What it is:** An integrated platform (web + operations + AI) built for salon owners, staff, and clients—not a generic booking widget bolted onto spreadsheets.
- **Who it is for:** Multi-location and ambitious single-location businesses that want speed, brand consistency, and automation without enterprise complexity.
- **Differentiation:** AI-native workflows (menu understanding, try-on, booking assistance), multi-tenant and multi-region readiness, and a premium product feel.

## Core Principles

- **AI-first, human-clear:** Automate the tedious; keep owners in control of policy and brand.
- **Speed and clarity:** Clean UI, short paths to value, no clutter.
- **Multi-tenant by design:** Isolation, permissions, and scalability are assumed from day one—not retrofitted.
- **Mobile reality:** Large share of use is on phone; design and test accordingly.

## Architecture Rules

- Modular boundaries: feature areas communicate through clear interfaces, not ad hoc coupling.
- **No hardcoding** salon-specific or tenant-specific data in shared code.
- **APIs and data access** belong outside render paths; no fetches in render.
- Favor **shared components and tokens** over one-off styles and copy-paste UI.
- **Storage and randomness** (e.g. `localStorage`, `Math.random`) are not used in ways that break SSR, hydration, or render purity where the stack requires it.
- Guard against **memory leaks** and **infinite loops** in effects, subscriptions, and state updates.

## Design System Rules

- **Aesthetic:** iPhone-like clarity, **premium dark UI**, **gold accent** `#D4AF37`.
- **Feel:** Clean, fast, high contrast where needed, generous spacing, readable type.
- **Colors:** No hardcoded colors scattered across the app; use design tokens or shared theme values.
- **Layout:** Mobile-first; scale up for tablet and desktop deliberately.

## Current Modules

*(Empty — product modules are not built yet. List implemented areas here as they land.)*

## Future Modules (major)

- **Website** — marketing and conversion surfaces.
- **Booking** — availability, services, and scheduling.
- **Staff** — roles, schedules, and permissions.
- **POS** — checkout, services, and payments at the counter.
- **CRM** — clients, history, and retention.
- **AI** — menu scan, nail try-on, booking assistant, and future assistants.
- **Automation engine** — rules, triggers, and workflows.
- **Analytics** — operations and growth metrics.
- **Viral / referral** — growth and share mechanics.
- **Multi-salon / multi-country** — tenants, regions, and compliance-friendly structure.

## Data Flow (high level)

1. **Client / staff / owner** use web (and later native or PWA) against **one app shell**.
2. **Authentication and tenant context** determine what data and UI are visible.
3. **Domain APIs** serve bookings, catalog, users, and analytics; the UI consumes them through a thin **client layer** (hooks, stores, or server actions—exact stack TBD in code).
4. **AI features** call dedicated services or model endpoints; results merge into existing flows (e.g. booking, catalog) without duplicating source of truth.
5. **Automation and analytics** read from the same system of record, not from shadow databases unless explicitly designed.

## Known Risks

- Scope creep across “full OS” features before core flows are shippable.
- Multi-tenant and regional rules (data residency, tax, payments) need explicit decisions as modules appear.
- AI features depend on data quality, permissions, and cost controls—must be designed with guardrails.

## Decisions Log

*(Empty — see [DECISIONS.md](./DECISIONS.md) for structured entries. Summaries or pointers can be mirrored here if useful.)*

## Next Steps

- Keep **PROJECT_BRAIN.md**, **CHANGELOG.md**, and **ROADMAP.md** in sync with reality.
- Complete **Phase 0 (Foundation)** per [ROADMAP.md](./ROADMAP.md) before large feature work.
- When implementation starts, list **current modules** above and link to key folders or packages.
