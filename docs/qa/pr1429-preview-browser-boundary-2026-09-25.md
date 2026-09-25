# PR1429 Preview browser boundary

- Current published head: `5dff0ecc5ed03db52a1ac93d75cb256deb13cf72`; Draft.
- Corrected-head Preview READY: `dpl_Ah6VbFDDDRSgRu5qv7tov8xXtCTj`, https://nailiq-gj1muqf4c-bepnhobencha-2588s-projects.vercel.app . Branch QA configuration was installed before this deployment.
- CI on head `5dff0ecc` failed Build & Type Check because exact-shape regression tests retained the old counts. Other E2E jobs were still pending during this investigation. Run 36185577254 contains this failure; preserve it.
- Updated the exact expected shape in `releaseSchemaContract.ts`, its mutation-test cases and the Waitlist parity assertion. These match the hosted QA rehearsal delta. Local focused regression 14/14 PASS, security test folder 1422/1422 PASS, typecheck PASS.
- Computer-use test on preceding app-identical head `7565f592` reached login. Synthetic QA credentials entered without logging or saving values. Both button and keyboard submission ended with "We could not confirm whether your request completed". Runtime logs contained GET /login only, no matching login POST.
- Firewall read-only inspection found the stale-deployment-writers deny rule excluding these Preview hosts. The active rule already has one additional exact-host exception for another deployment; an unrelated unpublished draft changes its allowlist. Any publish operation would publish all draft changes together. Preserve that draft and active rule during a scoped exception. No WAF change had yet been made at the point of this report; the first hosted authenticated UI test remained blocked.
- Created only a dedicated synthetic QA owner, salon, service, staff, disabled sandbox integration, and future booking. Removed the exact fixture rows/account after the blocked test. Verified salon count zero and card-email receipt count zero. No provider calls or real messages.
- Production before/after: `dpl_93ZAvNVmmdpf48sMpLuifg3cTSVf`, SHA `006da9b322d3da154cb2f4bc36a491616957a631`.
- Next authorization required: narrowly scoped access for the verified QA Preview through the existing WAF fence, preserving Production/cron protections and unrelated draft changes. Do not bypass the fence by repointing an already allowlisted hostname.

This follow-up evidence file is local, not yet committed. Published code and parity fix are already pushed to PR1429.
