# Receptionist mobile visual baseline refresh

## Scope

Review and, only if valid, refresh the Linux snapshot for the receptionist
center after the intentional mobile workflow changes merged in:

- #945 — mobile lateness and no-show parity
- #946 — mobile off-hours booking slots
- #947 — mobile walk-in assignment
- #948 — assignment actions and Undo toast reachability

The repository's main-branch visual workflow must generate the Linux baseline
with Playwright so that the image is produced in the same environment used for
comparison. Hand-edited PNGs are not accepted.

## Evidence

The post-merge visual job for #949 reported only the receptionist-center mobile
snapshot as stale:

- expected: `390x1324`
- received: `390x1348`
- difference: `20,858` pixels (`4%`)
- desktop and the other visual surfaces passed

Smoke, build, type checking, and the PR's receptionist-center E2E gate passed
before deployment. The 24-pixel height change was therefore a review trigger,
not proof that a baseline update was correct.

## Generated-branch review outcome

Main run `30137215790` generated branch
`automation/visual-baselines-30137215790`. It was rejected rather than merged:

- the mobile public-booking snapshot contained only the Suspense loading
  skeleton;
- the two receptionist snapshots captured a Friday closing brief and current
  time/date, while the prior baseline captured a Wednesday morning brief;
- the generated branch therefore changed three PNGs, not only the intended
  receptionist-mobile surface.

The visual test now waits for the resolved booking body and the hydrated
receptionist timeline. It also fixes browser time at 10:00 AM Vancouver time
and passes the matching explicit receptionist date, so daily-brief and Now-line
pixels do not depend on the wall clock.

Main run `30138311986` then proved the booking readiness fix (all non-mobile
visual cases passed), but exposed a viewport-specific assertion: it waited only
for the desktop `StaffTimelineGrid`, while the hydrated mobile board correctly
swaps to `VerticalDayView`. The readiness gate now accepts the rendered schedule
surface for either breakpoint.

## Refresh and review procedure

1. Preserve `[update-snapshots]` in the squash-merge title.
2. Let the `Visual Regression` job on `main` run with
   `--update-snapshots`.
3. Review the generated `automation/visual-baselines-<run-id>` branch.
4. Reject the branch if any page is still loading, the date/time differs from
   the fixed fixture, or an unrelated visual surface changed.
5. Merge only the generated Linux snapshots whose pixel changes match the
   reviewed, intentional UI.
6. Re-run the normal visual comparison and require it to pass.
