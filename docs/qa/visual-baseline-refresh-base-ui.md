# Visual baseline refresh — Base UI gating (#214/#215)

## Why this PR exists
PRs #214/#215 gated Beta release modules behind feature flags (Base release =
flags OFF). This intentionally changed the rendered output of three of the four
visual-regression surfaces. The Linux baselines were last refreshed on
2026-05-24 (`0d43ecd`) and the #215 merge did **not** carry `[update-snapshots]`,
so the `Visual Regression` CI job on `main` is red on **expected** drift.

## What changed visually (expected — not a bug)
- **Public booking** (`booking-*`): Individual/Group toggle now hidden
  (`group_booking` flag OFF). Seed salon has 1 staff → toggle previously shown.
- **Receptionist center** (`dashboard-center-*`): party-card strip hidden
  (`group_booking`), gated beta nav items removed from sidebar.
- **Setup wizard** (`dashboard-setup-*`): gated beta nav items removed from
  the shared dashboard sidebar.
- **Register** (`register-*`): not gated → **no drift, unchanged.**

## Mechanism (do not hand-edit PNGs)
This repo refreshes Linux baselines only via CI on push-to-main. The
`visual-tests` job greps the head commit message for `[update-snapshots]`,
runs Playwright with `--update-snapshots`, and self-commits the changed
`*-linux.png` baselines back to `main`.

**This PR carries no PNG diff on purpose.** On squash-merge, the merge commit
message must retain the `[update-snapshots]` token so CI regenerates the
baselines automatically.

### Expected files CI will refresh after merge
- `e2e/visual/visual-regression.spec.ts-snapshots/booking-*-linux.png`
- `e2e/visual/visual-regression.spec.ts-snapshots/dashboard-center-*-linux.png`
- `e2e/visual/visual-regression.spec.ts-snapshots/dashboard-setup-*-linux.png`

### Untouched by design
- `register-*` snapshots (no visual change → CI commits nothing for them)
- all `*-darwin.png` baselines (CI only generates Linux)
- app source, test source, feature flags, PR3
