# Decisions Log
> Last updated: 2026-05-03 (afternoon)
> Format: ADR-lite. Mỗi decision = 1 entry. Reverse chronological (newest first).

---

## Cách dùng file này

**Khi nào add entry:**
- Decision có cost > 1 ngày work để reverse (ví dụ: chọn Stripe vs Paddle)
- Decision affect data model hoặc public API
- Decision liên quan pricing, positioning, scope V1
- Decision reject một feature/approach có lý do quan trọng cần nhớ
- Decision tích luỹ tech debt có chủ ý

**Khi nào KHÔNG cần add:**
- Implementation details (chọn function name, file structure nhỏ)
- Decisions trivial reverse được trong < 30 phút
- Refactor scope nhỏ

**Format chuẩn (copy template dưới):**

```markdown
## YYYY-MM-DD: [Decision title ngắn, action-oriented]
**Context**: [Tình huống dẫn đến decision này. 1-3 câu.]

**Decision**: [Quyết định cụ thể. 1 câu.]

**Rationale**:
- [Lý do #1]
- [Lý do #2]
- [Lý do #3]

**Alternatives rejected**:
- [Option A]: [tại sao không]
- [Option B]: [tại sao không]

**Trade-offs accepted**: [Cái gì bạn sacrifice khi chọn cái này]

**Revisit when**: [Trigger cụ thể để re-evaluate. KHÔNG ghi "later" hoặc "post-launch".]

**Cost to reverse**: [Low / Medium / High + estimate hours nếu cần]
```

---

## Anti-patterns trong decision log

❌ **"Vague trigger"**: "Revisit later" → useless. Ghi cụ thể: "Khi có 10+ paying" hoặc "Sau 50 trial signups"

❌ **"Decision không có rationale"**: chỉ ghi "Chọn X" không giải thích → 3 tháng sau không nhớ tại sao, dễ flip-flop

❌ **"Rationale post-hoc"**: viết entry sau khi quyết định 2 tuần → memory bias, rationalize sai. Add ngay trong ngày quyết định.

❌ **"Decision quá nhỏ"**: "Chọn tên biến X" → noise, dilute file

---

# Entries

---

## 2026-07-28: Keep Reports analytics outside the initial RSC stream

**Context**: Two production deployments continued to reproduce React invariant
`#310` in Next's root App Router even after removing memo hooks and the Reports
Server Action proxy. Local Chromium/WebKit checks passed, while production with
real analytics data failed during initial route hydration.

**Decision**: Server-render only the authorized Reports shell and load every
analytics snapshot through the authenticated, non-cacheable REST boundary after
client hydration.

**Rationale**:
- Keeps data-dependent report work out of Next's root hydration/action queue.
- Uses one observable transport for both the initial and changed date ranges.
- Preserves owner authorization and fail-honest error states at the API boundary.

**Alternatives rejected**:
- Embed the first snapshot in RSC: production evidence disproved this twice.
- Reintroduce a mount-time Server Action: it couples analytics to the App Router
  action queue and had already failed production verification.

**Trade-offs accepted**: The report shell briefly shows a bounded loading state
before KPIs populate.

**Revisit when**: Next/React provides an upstream fix with a production
regression proving the real-salon initial RSC snapshot no longer trips `#310`.

**Cost to reverse**: Low; restore the server loader call and initial prop.

---

## 2026-05-10: Superadmin Foundation Shell V1 — build architecture, defer scale features

**Context**: PR #82 (2026-05-10) shipped a minimal Huy-only Superadmin panel: `/superadmin` route, `public.superadmins` binary membership table, per-salon `plan_override` + `feature_flags` JSONB columns, route gate via `isSuperAdmin(userId)`. The panel covers plan + flag overrides for beta partners but **does not** include sidebar navigation, multi-role gating, salon list, impersonation (login-as-salon), audit logs, announcements, or platform-level feature flags. Founder direction is to build the **architecture shell** for those capabilities now — before scale features — so the route surface, role model, and audit contract are settled while we still have ≤ 3 paying salons.

**Decision**: Build **Superadmin Foundation Shell V1** on top of PR #82. Scope = auth + protected routes + layout shell + sidebar + salon list/detail (read-only) + impersonation foundation + audit log table + minimal feature flags + announcements + disabled module placeholders for Phase 2/3 routes. Explicitly **defer** AI Ops, rollout engine, advanced analytics, risk engine, churn prediction, live ops, billing infrastructure beyond minimal flags.

**Phasing** (committed):

| Phase | Scope | Estimate |
|---|---|---|
| 1A | DB schema + RLS — `superadmins.role` column, `superadmin_audit_logs`, `platform_feature_flags`, `platform_announcements` | 2-3h |
| 1B | Auth surface — `/superadmin/login` (Supabase Auth, email+password), role gate in server components | 3-4h |
| 1C | Shell + sidebar + ~30 disabled-module routes per `DASHBOARD_LAYOUT_RULES.md` §10 | 4-5h |
| 1D | Salon list + detail (read-only) | 4-5h |
| 1E | Impersonation foundation — cookie swap via service-role, audit log on enter/exit, persistent banner, 30-min expiry, founder-only | 4-6h |
| 1F | Feature flags admin + announcements admin (minimal) | 2-3h |

**Total**: ~20-25h ≈ 3 days of focused work, spread across 5-7 calendar days non-blocking with V1 launch.

**Guardrail (non-negotiable)**: V1 launch blockers **always** override Superadmin work. If auth breaks, queue breaks, E2E fails critically, or Twilio/Stripe/Resend issues appear → Superadmin sprint pauses immediately, resumes only when launch track is green.

**Rationale**:
- **Foundation before scale.** Building the route surface + role model + audit contract now (when there are 0 paying salons) is cheap. Retrofitting them after 50+ paying salons — with live impersonation needs, real audit obligations, regional split, etc. — is exponentially more expensive.
- **No premature complexity.** Foundation V1 explicitly excludes business logic (AI ops, billing engine, risk, rollouts). It is **architecture placeholder**, not fake business logic. Disabled modules render as `<span>` with concrete phase labels, not fake forms with no-op handlers.
- **Real impersonation, not skeleton.** Login-as-salon is the single highest-value Superadmin feature for early-stage support (beta partners hitting bugs at the desk). PM explicitly approved real backend implementation with cookie swap, audit log, banner, 30-min expiry.
- **Audit obligation lands now.** PR #82 explicitly deferred audit logs because `booking_events` is booking-scoped. Foundation V1 ships the dedicated `superadmin_audit_logs` table so every privileged action from this point forward leaves a trail. Operating without that is a compliance liability once we have paying salons.

**Alternatives rejected**:
- **Full Superadmin (AI Ops, billing engine, risk, rollouts, analytics) now**: prompt-engineering ambition, not real need. ~3-5 weeks of work, conflicts directly with V1 launch in ~20 days. PM and Claude aligned on rejecting this on 2026-05-10 after initial prompt rewrite.
- **Defer all Superadmin to post-launch**: founder explicitly wants `support_admin` and `founder` impersonation available when first beta salon hits a bug. Without that, support burden = full-screen-share + careful click coaching, which does not scale.
- **Build only `superadmin_audit_logs` for now, defer the shell**: technically possible but loses the architectural-shell benefit. The shell + audit table land together so audit semantics are not retrofitted onto a later sidebar redesign.

**Trade-offs accepted**:
- 3 days of dev time during a V1-launch sprint, partially budget-protected by the guardrail above.
- Disabled-module pattern requires discipline — every Phase 2/3 placeholder must NOT render a fake form. Easy to drift toward "fake it for the demo" if not policed.
- Two role axes (salon-scoped + platform-scoped) increases cognitive load on every new server action author. `PERMISSION_MATRIX.md` §8 calls this out explicitly.

**Revisit when**:
- 3+ paying salons live → re-evaluate Phase 2 priority (incident center vs billing analytics vs AI ops vs rollout engine).
- First impersonation audit-log review with PM → judge whether `support_admin` should be promoted to impersonation rights.
- Any single Phase 2/3 placeholder route sits without real implementation for > 6 months → drop it from the sidebar entirely rather than carry dead architecture.

**Cost to reverse**: Medium-low. Foundation V1 is additive — drop the `/superadmin/*` route family and the `superadmin_audit_logs` table; existing salon-facing code is untouched. ~1 day to fully unwind.

**Governance amendments shipped same day**:
- `docs/PERMISSION_MATRIX.md` §8 — Superadmin role contract, impersonation rules, server action audit-or-rollback.
- `docs/DASHBOARD_LAYOUT_RULES.md` §10 — Superadmin sidebar geometry, navigation, disabled module pattern, impersonation banner.

**PM approval**: in-chat 2026-05-10, after explicit Foundation-Shell-only scope clarification and rejection of full-Superadmin prompt.

---

## 2026-05-03 (afternoon): V1.1 backlog from Q1 ship review — defer add-service, smart conflicts, price override

**Context**: Q1 founder review surfaced three Receptionist / booking ideas for after V1: (1) **add service** to an existing booking (real nail workflow: booked Manicure, client adds Pedicure) vs today’s **replace**-one-service model — implies schema move from 1:1 service + addon toward **N:N or service array** (~2–3 days); (2) **smart conflict suggestions** instead of flat “slot taken” — e.g. “Mai busy 3pm. Try Trang 3pm or Mai 4pm” via cross-staff + same-staff alt slots (~2–3 days); (3) **custom price override** with toggle off default auto-price (~1–2h). Stage is **0 paying customers**; outreach is the bottleneck, not feature depth.

**Decision**: Defer all three to **V1.1**. **Q1 V1** ships **as-is**: desk edit remains **time + staff + service replace** only (locked spec 2026-05-03). Do not build the three items pre-launch.

**Rationale**:
- Building now ≈ **5–7 days** delay → risks missing launch window and still yields **zero beta signal** on which idea matters.
- Correct V1.1 priorities should follow **V1 → beta install → real usage** data, not pre-revenue speculation.
- Smallest ask (#3) stays cheap to add when **2+ beta** explicitly request it; #1 waits for **5+ beta** explicit asks (schema cost); #2 for **3+ beta** conflict-UX complaints (or skip if owners adapt).

**Alternatives rejected**:
- Ship “add service” or smart suggestions in V1: scope + schedule risk with no validating customers yet.
- Build price override alone “because it’s fast”: still distracts from outreach and launch closure.

**Activation triggers (revisit post-beta)**:
- **#1 Add service / multi-service booking:** **5+** beta salons explicitly ask → allow schema redesign (N:N / array).
- **#2 Smart conflict suggestions:** **3+** beta complain about conflict UX → prioritize engine; else defer if owners tolerate current error pattern.
- **#3 Custom price override:** **2+** beta ask → quick add.

**Trade-offs accepted**: V1 desk stays “replace service” not “add service”; conflicts stay message-based without alternates; no manual price line on booking edit in V1.

**Revisit when**: After beta installs — tally explicit asks / complaints against triggers above; re-read this entry before scoping V1.1.

**Cost to reverse**: **Low** — no V1 code paths committed to multi-service or suggestion engine; re-read `decisions-log.md` this entry post-beta.

---

## 2026-05-03: Q1 desk edit booking — pending/confirmed only, no in_progress

**Context**: Receptionist needs ability to reschedule/adjust bookings (change time, staff, service) without cancel+rebook workflow. Q1 from failure mode review pre-launch.

**Decision**: Edit allowed ONLY for status='pending' or 'confirmed'. Block edit for in_progress (currently being served), completed (history), cancelled (terminal), waiting (use assign flow instead).

**Rationale**:
- in_progress edit creates data integrity issues: started_at vs new start_time_utc divergence, staff actually doing different service than booking record
- completed/cancelled are terminal — edit doesn't make sense
- waiting bookings (walk-ins) have separate assign flow with its own conflict check
- Pending/confirmed cover 95% of real reschedule cases (customer call ahead)

**Alternatives rejected**:
- Allow in_progress edit with confirmation modal: too risky for V1, mid-service data corruption
- Allow all statuses with status-aware logic: scope creep, complex UI states
- Drag-to-reschedule on grid: deferred to V1.1+ (parking lot)
- Edit customer name/phone/notes: separate feature, V1.1+

**Trade-offs accepted**:
- in_progress mistakes (wrong staff/time) require cancel + rebuild — friction acceptable, rare
- No bulk edit (multi-booking move) — defer

**Revisit when**:
- 5+ beta users explicit ask "I need to edit booking after starting"
- Or 3+ beta users complain about cancel+rebuild friction

**Cost to reverse**: Low (~1h: relax status check + add server-side started_at handling)

---

## 2026-05-02 (afternoon): Staff delete detaches terminal bookings (NULL staff_id)

**Context**: Task 4 of pre-launch blockers. Owner needs to delete inactive staff. FK RESTRICT on bookings.staff_id blocks delete if any booking (including completed/cancelled) references the staff. Test st-2 surfaced this: even with no future bookings, DELETE staff fails because of completed history.

**Decision**: Before DELETE staff, application-level UPDATE bookings SET staff_id=NULL WHERE status IN ('cancelled','completed'). Also clear client_profiles.preferred_staff_id. Active bookings (pending/confirmed/in_progress/waiting) BLOCK delete with staff_has_bookings error.

**Rationale**:
- Allow owners to clean up inactive staff list (essential UX)
- Preserve booking rows (revenue history intact, just no staff attribution for old rows)
- Block delete when active bookings exist (receptionist can't operate on null-staff active rows)
- Application-level UPDATE > DB ON DELETE SET NULL: explicit in code, easier to audit, doesn't change schema constraints

**Alternatives rejected**:
- Block delete if ANY booking references staff (including completed): owner stuck with old staff names cluttering list, bad UX
- ON DELETE CASCADE on bookings: deletes booking history, loses revenue + audit data
- ON DELETE SET NULL via FK: silent, harder to audit, doesn't allow custom logic later (e.g. notify other staff of reassignment)
- Keep staff_id on completed but mark "archived" via flag: schema bloat, doesn't solve the "can't delete" problem

**Trade-offs accepted**:
- Completed bookings older than staff deletion show "Staff: Unknown" or null in reports
- Owner audit trail loses staff attribution for old data
- client_profiles.preferred_staff_id cleared = customer's preferred-staff memory wiped if staff deleted

**Revisit when**:
- If owner reports complain about losing staff attribution in reports → consider archive flag pattern
- If we add commission tracking: archive history before allowing detach

**Cost to reverse**: Medium (~2-3 hours: change cascade approach + migrate existing data + update reports)

---

## 2026-05-02 (afternoon): Cancelled in_progress booking keeps started_at

**Context**: Step 6c-1 drawer cancel action allows cancelling in_progress bookings. Current implementation only updates status, does not clear started_at.

**Decision**: Keep started_at on cancelled bookings (no cleanup).

**Rationale**:
- started_at is operational record (when service started physically)
- Cancellation = customer left or service stopped, not erasure of history
- Future analytics may want "average time in chair before cancel" — needs started_at
- Cleanup adds complexity for marginal benefit V1

**Alternatives rejected**:
- Clear started_at on cancel: loses data, rare ops insight

**Trade-offs accepted**:
- Cancelled rows have non-null started_at — queries filtering "in_progress AND started_at IS NOT NULL" still need explicit status filter
- Documented here so future dev doesn't treat as bug

**Revisit when**: Real ops feedback indicates need to clear started_at on cancel

**Cost to reverse**: Low (~30min: add UPDATE to set started_at = NULL on cancel transition)

---

## 2026-05-02: Owner today list — wide server load + narrow client filter

**Context**: Step 2 of Receptionist Center build. Owner dashboard "today list" needs to (a) hide walk-in waiting + cancelled from agenda view but (b) include completed rows for today's stats (revenue, completed count). Single filter at server can't do both.

**Decision**: Server `loadSalonOwnerDashboard` filters `status IN ACTIVE_GRID_STATUSES` (pending, confirmed, in_progress, completed). Client `splitSalonDashboardBookings` further filters rendered "today" list to `OWNER_TODAY_LIST_STATUSES` (pending, confirmed, in_progress) while keeping completed for stats derivation.

**Rationale**:
- Server filter excludes waiting + cancelled = correct (those are walk-in queue noise + terminal state)
- Server include completed = required for revenue/count math
- Client narrow filter for display = clean agenda UX (don't show "Anna · 9am · completed" in upcoming list)
- 2 filter layers documented = explicit, not magic

**Alternatives rejected**:
- Server filter to OWNER_TODAY_LIST_STATUSES only: zeros out completed stats
- Server load ALL statuses: pulls cancelled + waiting (walk-in noise) into owner payload, increases data transfer
- Compute stats server-side via separate query: 2 round-trips, more code, same outcome

**Trade-offs accepted**:
- Two filter constants (ACTIVE_GRID_STATUSES, OWNER_TODAY_LIST_STATUSES) — must keep both in sync semantically
- Future dev sees client-side filter and wonders why — entry references this decision

**Revisit when**:
- If/when bookings table grows so large that loading all 4 statuses becomes slow → consider 2 separate queries
- If completed bookings need to appear in agenda for some UX reason

**Cost to reverse**: Low (~30min: collapse to single filter, accept stat regression)

---

## 2026-05-02: Parking lot tổng hợp — AI features + Payment + Luxury widgets defer post-PMF

**Context**: Trong 1 ngày nhận 3 rounds feedback (owner dashboard ultra-luxury, "15/10 system", flash metrics + AI insights drawer + AI voice pill) — tất cả push về AI/luxury direction. Reject từng feature riêng lẻ tốn time + dễ re-debate khi feedback round tiếp theo. Cần entry tổng hợp để reference 1 lần, không re-litigate.

**Decision**: Defer toàn bộ feature group dưới đây sang post-PMF với 1 trigger thống nhất. KHÔNG build trong V1, KHÔNG mock UI cho V1, KHÔNG hint trong copy/marketing rằng sắp có.

Features defer cùng group:
1. AI Smart Suggest — gợi ý assign walk-in cho staff/slot tối ưu
2. AI Voice Receptionist — agent trả lời điện thoại tự động
3. AI Upsell Suggestion — gợi ý add-on dịch vụ trong drawer booking
4. AI ROI Tracker / "AI Revenue Added" metric — số tiền AI mang về
5. Auto-assign mode (kể cả rule-based marketed dưới brand "AI")
6. Workload Predictor / load bar (40%/70%/100%) per staff
7. VIP tag + customer habits + AI insights card trong drawer
8. Wait time prediction cho khách trong queue
9. Bulk multi-assign (chọn nhiều walk-in cùng lúc)
10. Square Terminal / Clover payment integration trực tiếp trong app
11. Marketing automation — rotating SMS tới khách cũ để fill empty slot
12. Drag-to-reschedule + resize block trên timeline
13. "AI System Status" indicators (pulsing pills, AI on/off badges)
14. Sentry "24/7 protection" badge user-facing

**Rationale**:

Strategic — tại sao defer cùng group:
- Tất cả violate ít nhất 1 dòng trong product.md "DO NOT BUILD V1" table
- Stage hiện tại: 0 paying customers, 4 tuần đến launch. Mỗi giờ build mock UI vaporware = 1 giờ KHÔNG build walk-in queue (H3 differentiator thật)
- Target user (salon owner Việt 35-55 từ paper + Zalo) pay $29/mo vì giá + workflow fit, KHÔNG vì AI/luxury vibe
- Feature 1-9 không có data foundation: 0 historical bookings ngày 1 → AI suggest = random; client_profiles không có VIP flag, habit aggregation
- Feature 10 (payment) = PCI scope + 6 tuần dev minimum, Square/Clover đã solve standalone
- Feature 14 (Sentry badge) = lừa user vì Sentry là dev monitoring không phải user-facing security

Tactical — tại sao KHÔNG mock UI:
- Mock UI cho feature không tồn tại = lừa user trong onboarding trial
- Receptionist sẽ hỏi "AI nào? Sao tôi không thấy hoạt động?" → trust gone, churn
- Marketing demo wow ≠ paying customer (Decision 2026-05-02 single-product focus đã lock không gọi vốn)
- Production code base nên reflect features thật, không "coming soon" placeholders

**Alternatives rejected**:
- Build với feature flag default off, ship code: vẫn polluting codebase, vẫn cần maintain UI mock, vẫn risk leak qua dev console
- Build "lite" rule-based version marketed as AI: vẫn vaporware level marketing, transparent rule-based = tốt hơn nhưng vẫn không đủ ROI vs walk-in queue
- Build separate "marketing demo" version cho pitch deck: khả thi nhưng KHÔNG cần thiết vì không gọi vốn
- Reject từng feature một khi feedback đến: tốn time, trigger re-debate

**Trade-offs accepted**:
- V1 UI sẽ "boring" hơn so với Booksy/Vagaro mockup demo của họ — chấp nhận, function over form cho stage này
- Có thể mất 1-2 prospect mê AI/luxury vibe — chấp nhận, không phải target user
- Feedback source push features này sẽ frustrate — chấp nhận, reference entry này thay vì re-litigate
- Tech debt 0: vì không build thì không có debt

**Revisit when** (TẤT CẢ điều kiện phải đồng thời):
- $1k MRR (≥ 35 paying salons)
- Cùng 1 feature trong list trên được customer ask 3+ lần với willingness to pay
- Post-PMF signal: NPS ≥ 30, churn < 5%/month
- Founder bandwidth ≥ 50% free từ ops/support

Riêng từng feature có thể có trigger sớm hơn nếu vendor solve được mà không cần dev:
- Payment: integrate Stripe Connect (đã có Stripe trong roadmap) — earliest revisit khi Stripe subscription stable
- Wait time prediction: rule-based "sum duration trong queue" có thể ship ở Phase 2 nếu data show useful

**Cost to reverse** (nếu sau này build): High cumulative
- AI features cần data infrastructure (~2-4 tuần per feature)
- Payment integration: 6+ tuần PCI scope
- Voice receptionist: 3-6 tháng (Twilio Voice + LLM + state)
- Total nếu build sai timing: 6-12 tháng dev tốn cho features không paying customer ask

**Reference cho future feedback**:
Khi nhận feedback push features trong list này, response template:
> "Feature này đã defer trong decisions-log entry 2026-05-02 (parking lot tổng hợp). Trigger revisit: $1k MRR + 3 customer ask + post-PMF. Hiện tại Q2 focus là 3 paying salons với walk-in queue + booking flow. Sẽ revisit khi đạt trigger."

---

## 2026-05-02: Defer 18 lint errors đến post-launch

**Context**: Health check trước khi build walk-in queue. `npm run lint` exit 1 với 18 errors. Build pass, typecheck pass, 16/16 e2e pass. ESLint chưa hooked vào CI.

**Decision**: Defer toàn bộ 18 errors đến post-launch. Không fix tuần 5/5 - 11/5.

**Rationale**:
- Phần lớn (12/18) là cùng 1 pattern `react-hooks/set-state-in-effect` — rule mới React 19, perf hint không phải functional bug
- Fix systemic đụng `useBookingFlowState.ts` = booking critical path, rủi ro regress
- Estimate fix toàn bộ ~1 ngày = 25% budget Task 2 walk-in queue
- North Star Q2 là paying salons, không phải clean lint
- Build/tests pass = không user-facing impact

**Alternatives rejected**:
- Fix tất cả ngay: tốn budget Task 2, rủi ro regress booking flow
- Fix chỉ trivial (no-unescaped-entities): cosmetic, không đáng context switch
- Suppress với `eslint-disable`: che tech debt, không giải quyết

**Trade-offs accepted**:
- ESLint không clean — chấp nhận vì chưa có CI hooked
- Tech debt tích lũy — log lại để revisit

**Revisit when**:
- Setup CI/CD pipeline (sẽ block deploy nếu lint fail)
- Hoặc khi React 19 perf issue thực sự đo được qua Sentry / real user metrics
- Hoặc post-launch tech debt sprint sau khi có 5+ paying customers

**Cost to reverse**: Medium (~1 ngày fix toàn bộ + test regress booking flow)

---

## 2026-05-02: Free trial 14 ngày, no credit card required upfront

**Context**: Setup Stripe subscription cho V1 launch ~30/5. Phải quyết trial length trước khi configure Stripe products. Giữa 7 ngày vs 14 ngày.

**Decision**: 14 ngày free trial, không yêu cầu credit card khi sign up.

**Rationale**:
- Onboarding non-trivial: salon owner phải import customer list, setup staff/services, train ít nhất 1 nhân viên
- 7 ngày chưa qua đủ 1 weekend cycle (weekend = peak nail salon). 14 ngày = 2 weekends, full pattern
- Target user không SaaS-native (từ paper + Zalo) → cần thời gian học UX bilingual, build trust
- SMS reminder cần Twilio A2P 10DLC approved (1-3 tuần). 14 ngày buffer cho edge case Twilio chậm
- Stage 0 paying: cần data + word-of-mouth, urgency không phải vấn đề. Trial abuse cũng không (chưa có ai để abuse)

**Alternatives rejected**:
- 7 ngày: force urgency nhưng không phù hợp stage hiện tại. User abandonment risk cao.
- 30 ngày: quá dài, dilute commitment signal, không cần thiết
- Credit card upfront: friction quá cao cho user paper-based, sẽ kill conversion

**Trade-offs accepted**:
- Higher trial-to-paid window cost (Twilio SMS, infra) — chấp nhận vì stage cần volume
- Có thể có "tourist" trial users không serious — OK, learn pattern

**Revisit when**:
- Có 10+ paying customers → A/B test 7 vs 14
- Hoặc khi thấy >30% trial không activate trong 7 ngày đầu (signal 7 ngày cũng đủ)
- Hoặc khi infra cost cho free trial > $X/month

**Cost to reverse**: Low (~2-4h: update Stripe config, marketing copy, onboarding email)

---

## 2026-05-02: Single-product focus — NAILIQ OS only, defer consulting + restaurant OS + marketplace

**Context**: Founder cân nhắc mở consulting agency + restaurant OS + marketplace song song với NAILIQ OS. Đang ở pre-launch, solo dev, 4 tuần đến V1, 0 paying customers. Vision rộng (Vietnamese SMB automation toàn cầu) khác hẳn execution NAILIQ OS V1 (Vietnamese nail salon US/Canada).

**Decision**: Trong 12 tháng tới chỉ làm NAILIQ OS. KHÔNG build trang công ty mẹ, KHÔNG bắt đầu consulting service line, KHÔNG touch restaurant vertical. 1 domain (nailiq), 1 product, 1 customer segment.

**Rationale**:
- Solo dev không thể split attention 3 product lines + 1 service line
- Customer NAILIQ (salon owner Việt) không care vision lớn — care $29 vs Booksy + workflow fit
- Trang công ty mẹ = signal "nhiều thứ đang làm dở" khi chưa shipped cái nào
- Niche Vietnamese nail US/Canada đủ lớn để nuôi business 5 năm
- Track record: founders làm nhiều thứ cùng lúc thường thất bại do attention split, không phải idea sai
- Pattern test "cho $50k làm gì": founder chọn customer outreach over website building → đúng founder mindset

**Alternatives rejected**:
- Build trang công ty mẹ với 3 sản phẩm: scope creep ở level identity, hút 2-3 ngày khỏi launch tasks
- Marketplace vertical từ đầu: multi-sided platform = N năm dev, sai stage
- Consulting song song: B2B services khác B2B SaaS, customer khác, sales cycle khác → không synergy thật ở stage này

**Trade-offs accepted**:
- Vision lớn phải đợi 12+ tháng
- Có thể bỏ lỡ "first mover" trên restaurant vertical — chấp nhận, niche đủ lâu để revisit
- Brand "nailiq" specific, khó pivot sang restaurant nếu sau này muốn — chấp nhận, bridge that bridge later

**Revisit when**:
- NAILIQ đạt $5k MRR + 20 paying salons → consider restaurant OS planning (Phase 2)
- NAILIQ đạt $50k MRR → consider company holding structure + consulting service line
- Hoặc khi customer NAILIQ ask: "Anh có làm cho nhà hàng không?" 5+ lần với willingness to pay

**Cost to reverse**: Low (~1 ngày: domain redirect, marketing copy update) — vision không bị xóa, chỉ defer.

---

## [Add new entries above this line]

<!--
TEMPLATE để copy paste:

## YYYY-MM-DD: [Decision title]
**Context**:

**Decision**:

**Rationale**:
-
-

**Alternatives rejected**:
- :
- :

**Trade-offs accepted**:

**Revisit when**:

**Cost to reverse**: Low/Medium/High
-->
