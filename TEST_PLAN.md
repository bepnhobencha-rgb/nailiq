# Test plan

Manual and automated checks to keep the product shippable. Expand with concrete steps and cases as features are built.

## Smoke / regression (minimum)

- **Landing loads** — Home/landing page renders without error; no blank or infinite loading state in normal network conditions.
- **Register works** — User can create an account; validation and error states behave; success path is reachable.
- **Setup flow** — New tenant/salon setup can be completed (or is clearly skippable where product allows) without dead ends.
- **Booking flow** — End-to-end path from “choose time/service” to confirmation works for the current scope; errors are handled gracefully.
- **No crash** — No unhandled client exceptions in happy paths; critical paths recover or show a safe message.
- **Mobile layout works** — Key screens are usable on small viewports: tap targets, scroll, and navigation do not break.

## Future

- Add automated e2e and visual regression for critical paths as the stack matures.
- Add performance and accessibility checks in CI when the project is ready.
