# Decisions Log
> Last updated: 2026-05-02
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
