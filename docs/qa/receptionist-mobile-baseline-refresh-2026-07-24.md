# Receptionist mobile visual baseline refresh

## Scope

Refresh the Linux snapshot for the receptionist center after the intentional
mobile workflow changes merged in:

- #945 — mobile lateness and no-show parity
- #946 — mobile off-hours booking slots
- #947 — mobile walk-in assignment
- #948 — assignment actions and Undo toast reachability

No application code or hand-edited PNG is included in this change. The
repository's main-branch visual workflow must generate the Linux baseline with
Playwright so that the image is produced in the same environment used for
comparison.

## Evidence

The post-merge visual job for #949 reported only the receptionist-center mobile
snapshot as stale:

- expected: `390x1324`
- received: `390x1348`
- difference: `20,858` pixels (`4%`)
- desktop and the other visual surfaces passed

The additional 24 pixels follow the intentional mobile controls added after the
last approved baseline refresh (`719725c9`). Smoke, build, type checking, and
the PR's receptionist-center E2E gate passed before deployment.

## Refresh and review procedure

1. Preserve `[update-snapshots]` in the squash-merge title.
2. Let the `Visual Regression` job on `main` run with
   `--update-snapshots`.
3. Review the generated `automation/visual-baselines-<run-id>` branch.
4. Merge only the generated Linux snapshot for the receptionist center after
   confirming that no unrelated visual surface changed.
5. Re-run the normal visual comparison and require it to pass.
