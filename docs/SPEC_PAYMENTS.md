# SPEC — Payments / No-show protection (Square ⇄ Stripe)

> Status: approved by Huy 2026-06-14. Đợt 1 = Square end-to-end; Đợt 2 = Stripe Connect.

> **Current truth (2026-08-29):** phần no-show charge bên dưới là thiết kế lịch
> sử. Hợp đồng hiện tại dùng undo **60 giây**, tách attendance / fee approval /
> payment truth, chỉ Owner/Admin được Charge hoặc Waive, và receipt phê duyệt là
> bất biến. Approval không tự gọi provider; dispatch mặc định OFF, cần release
> gate + salon allowlist. Consent chỉ được tái dùng khi policy version, mức phí,
> currency và group scope khớp hoàn toàn.

## 1. Mục tiêu & người dùng
Khi khách đặt **online**, **khách mới** (và khách **rủi ro no-show cao**) **bắt buộc lưu thẻ** (card-on-file, **KHÔNG trừ tiền lúc đặt**). Nếu sau này khách **no-show**, **nhân viên có quyền tick "thu / không thu"** phí. Mỗi salon **tự chọn 1 provider** (Square hoặc Stripe) **lúc set up tiệm** bằng **1-bấm OAuth**; provider đã chọn được dùng cho **mọi giao dịch tiền**.

## 1b. Quyết định cuối (2026-06-14)
- **Cả hai provider, theo setting salon** (chọn 1-bấm OAuth lúc set up). Hi-Lite sẽ chọn **Stripe** để được trải nghiệm wow.
- **Wow = 1 chạm Face ID**: chỉ **Stripe** lưu được thẻ từ **Apple/Google Pay** (SetupIntent off-session, không trừ tiền). **Square = nhập thẻ tay** (không lưu được ví số — đã kiểm). Nút "Xác nhận hẹn" có thể chính là tờ Apple/Google Pay.
- **Bắt buộc cho khách lần đầu + rủi ro cao** theo mô hình **"giữ chỗ tới khi có thẻ"** (booking pending → confirm khi lưu thẻ → auto-nhả nếu bỏ ngang). Risk score tính lúc tạo hẹn nên phải tạo trước rồi mới gate.
- **Không phiền**: khách quen sạch lịch sử KHÔNG bị hỏi; khách đã có thẻ trên hồ sơ KHÔNG hỏi lại; thẻ tự cập nhật khi hết hạn (card-updater).

## 2. Tính năng cốt lõi (đã thống nhất)
- **Chọn provider trong Setup/Settings**: Square | Stripe (chọn 1) — **1-bấm OAuth** ("Connect with Square" / "Connect Stripe" → Stripe Connect). Nút **Test connection** + badge ✅/❌ + tên tài khoản. Khoá provider sau khi đã có thẻ khách đầu tiên (thẻ không chuyển provider được).
- **Online card-on-file (bắt buộc)** cho: khách **mới** (chưa từng có booking hoàn tất ở tiệm) **HOẶC** `no_show_risk_score ≥ ngưỡng`. Lưu thẻ off-session, **không charge**. Khách quen sạch lịch sử → **không bị hỏi** (ít ma sát).
- **Apple Pay / Google Pay 1-chạm** (Square Web Payments SDK / Stripe Payment Element) + ô nhập thẻ thường (fallback desktop).
- **Consent**: checkbox đồng ý chính sách no-show + cho phép lưu thẻ; lưu `noshow_consent_at` (bắt buộc để charge hợp pháp + chống chargeback).
- **No-show fee do Owner/Admin quyết**: đánh dấu no-show → **hoàn tác 60 giây** → commit attendance → tạo phiếu duyệt riêng `[Duyệt thu] / [Miễn]`. Duyệt thu chưa phải provider dispatch; charge dùng ledger/idempotency + webhook reconciliation.
- **Cấu hình phí**: % giá hoặc số tiền cố định; ngưỡng rủi ro; bật/tắt yêu cầu-lưu-thẻ-online. Trong Settings.

## 3. Baseline tự bake
- [x] Bilingual EN/VI mọi UI mới.
- [x] No hardcode: phí/ngưỡng/provider/keys đọc từ DB (`square_integrations` + bảng Stripe tương đương) / Settings.
- [x] Security: token/secret server-only, không echo; OAuth state chống CSRF; webhook idempotent + verify chữ ký; charge dùng idempotency key; số tiền tính **server-side** (không tin client).
- [x] Self-service Integration UI (OAuth + Test + badge) — đúng quy tắc autoapp.
- [x] Loading/empty/error states; toast; consent record.
- [x] Reusable: lớp `PaymentProvider` (app-agnostic) → cân nhắc `@autoapp/payments` (đã có factory Stripe) khi ổn định.

## 4. Failure modes & mitigations
| Failure mode | Mitigation |
|---|---|
| Charge 2 lần khi mark no-show nhiều lần | Idempotency key ổn định theo bookingId (đã có); `noshow_charge_status='charged'` → no-op |
| Thẻ hết hạn / decline lúc charge | Bắt lỗi, set `noshow_charge_status='failed'`, gửi SMS link cập nhật thẻ, cho retry; không làm hỏng desk action |
| Đổi provider khi đã có thẻ lưu | **Khoá** provider sau thẻ đầu tiên; đổi = phải thu thẻ lại (cảnh báo rõ) |
| Charge thẻ mà không có consent | Chặn charge nếu thiếu `noshow_consent_at`; lưu snapshot chính sách |
| Tin client gửi số tiền | Phí tính server-side từ `price_cents × percent` (hoặc fixed) trong policy |
| Khách đặt online nhưng không lưu thẻ (bắt buộc) | Không cho xác nhận hẹn tới khi lưu thẻ xong (cho new/high-risk) |
| OAuth callback giả mạo | `state` ký + TTL; verify trước khi lưu token |
| Tiền về sai tài khoản (đa salon) | Square OAuth = token per-salon; Stripe = Connect (Express) per-salon, payout về salon, app-fee về operator |

## 5. Kiến trúc
- **`PaymentProvider` interface** (`src/shared/integrations/payments/types.ts`):
  `saveCardOnFile`, `chargeSavedCard`, `refund`, `connectStatus`. Resolve theo `salon.payment_provider`.
- **SquareProvider**: bọc `src/shared/integrations/square/*` (đã có `saveCardOnFile`/`chargeSavedCard`/`refundPayment`/`ensureSquareCustomer`).
- **StripeProvider** (Đợt 2): Stripe Connect + SetupIntent (save) + off-session PaymentIntent (charge) + Refund.
- **Setting**: cột `salons.payment_provider` ('square'|'stripe'|null) + lock flag (suy ra: đã có booking nào `noshow_card_id`/`square_payment_link_id`).
- **Gate** (`noShowCardDecision`): `required = (cardChưaLưu) && featureOn && feeCents>0 && (isNewCustomer || risk ≥ threshold)`.
  - `isNewCustomer` = 0 booking trước đó (non-cancelled) cùng `client_phone` tại salon.

## 6. Module breakdown & thứ tự build

### Đợt 1 — Square end-to-end (Hi-Lite dùng được ngay)
1. **Gate mới**: thêm điều kiện *khách mới* vào `noShowCardDecision` (new OR high-risk). [nhỏ, làm trước]
2. **Bắt buộc + consent**: card-capture là bước **bắt buộc** trong luồng online cho new/high-risk; thêm checkbox consent + lưu `noshow_consent_at`.
3. **Apple/Google Pay**: bật wallet trong `NoShowCardCapture` (Web Payments SDK đã load).
4. **No-show charge UI**: phiếu duyệt Owner/Admin sau khi undo 60s đã commit; timeline chỉ báo “cần duyệt”, không hứa hành động chưa có.
5. **Square OAuth connect UI** trong Settings (thay cho nhập token tay): "Connect with Square" + Test + badge. `salons.payment_provider='square'`.
6. **Cấu hình phí** trong Settings (percent/fixed, threshold, on/off).

### Đợt 2 — Stripe
7. StripeProvider (SetupIntent/off-session/refund) + **Stripe Connect** onboarding ("Connect Stripe") + toggle provider trong Settings.
8. Migrate luồng deposit/charge qua lớp `PaymentProvider` chung; khoá provider sau thẻ đầu.

## 7. Tech stack
Next.js 16 + Supabase (đã có) + Square Web Payments SDK + Square OAuth; Đợt 2: Stripe Connect (Express) + Payment Element.

## 8. Test plan
- Unit: `noShowCardDecision` (new vs returning vs high-risk vs card-đã-lưu vs feature-off).
- E2E: online booking khách mới → lưu thẻ + exact-version consent → confirm; mark no-show → undo 60s → committed attendance → request review → Owner/Admin Charge/Waive → sandbox dispatch/reconcile/refund trước production.
- Prod smoke: 1 thẻ thật lưu + 1 charge thật + refund (sandbox trước).
