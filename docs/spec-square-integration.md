# SPEC — Square Integration (NailIQ)

> Trạng thái: **CHỜ DUYỆT** · Ngày: 2026-06-01 · Owner: Huy
> Square trước đây nằm trong parking lot (hoãn 2/5/2026 vì PCI scope + ~6 tuần). SPEC này mở lại với phạm vi có kiểm soát + phase rõ ràng.

## 1. Mục tiêu & người dùng
Cho phép mỗi salon (tenant) **tự kết nối tài khoản Square của họ** vào NailIQ để: thu deposit khi khách đặt lịch, đồng bộ menu dịch vụ lên Square Catalog, đồng bộ khách hàng, và (phase sau) thanh toán tại quầy bằng Square Terminal. Tiền chạy thẳng vào tài khoản Square của từng salon — NailIQ chỉ điều phối, không giữ tiền.

- **Người dùng chính:** Chủ/quản lý salon (ADMIN của tenant) — bấm "Connect Square" trong dashboard.
- **Vai trò phụ:** Khách đặt lịch (trả deposit), Superadmin (Huy — giám sát, không cầm credential của tenant).

## 2. Tính năng cốt lõi (đã thống nhất)
Anh đã chọn cả 4 mảng. Chia phase theo độ phức tạp / PCI:

### Phase 1 — Foundation (Connect Square per-tenant)
- [ ] OAuth flow: nút "Connect Square" trong dashboard settings → redirect Square OAuth → callback → lưu token.
- [ ] Bảng `square_integrations` (per-salon): `access_token`, `refresh_token`, `expires_at`, `merchant_id`, `location_id`, `enabled`, `environment` (sandbox|production), observability (`last_run_at`, `last_error`).
- [ ] Token refresh tự động (Square access token hết hạn ~30 ngày, dùng refresh_token).
- [ ] Disconnect / revoke flow.
- [ ] Feature flag `square_integration` (Beta, default OFF, bật cho salon pilot).

### Phase 2 — Thu deposit khi đặt lịch
- [ ] Hoàn thiện deposit flow đang dở (`useBookingFlowState.ts:732` hiện fallback OTP).
- [ ] Khách đặt lịch có `deposit_required=true` → tạo Square Payment Link / charge → trả về NailIQ.
- [ ] Thêm cột vào `bookings`: `square_payment_id`, `payment_status` (pending|paid|failed|refunded), `payment_amount_cents`.
- [ ] Webhook Square (`payment.updated`) → cập nhật `payment_status` của booking (HMAC verify, idempotent).
- [ ] Refund deposit khi salon huỷ (qua Square API).
- [ ] Reconciliation: script đối soát deposit Square ↔ booking NailIQ.

### Phase 3 — Sync Catalog + Customer
- [ ] Catalog sync 1 chiều: NailIQ `services` → Square Catalog (create/update/delete item + price + duration).
- [ ] Customer sync: `client_profiles` (phone/email) ↔ Square Customers (create-if-missing, link `square_customer_id`).
- [ ] Cron sync stateless (theo mẫu wix-sync) hoặc trigger on-write.

### Phase 4 — POS tại quầy (TÁCH RIÊNG, chưa làm đợt này)
- [ ] Square Terminal checkout tại salon. **Cần:** PCI scope review + thiết bị Square thật + ~6 tuần. SPEC chi tiết viết riêng khi tới phase này.

## 3. Baseline tự bake (KHÔNG cần hỏi — luôn có)
- [ ] Credential KHÔNG hardcode: token lưu DB (`square_integrations`), Square App ID/Secret trong env (`SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_ENVIRONMENT`).
- [ ] Secret không bao giờ trả về browser; masked khi hiển thị; chỉ service-role đọc bảng integration (RLS deny-all auth/anon).
- [ ] Security: server-side trust amount (deposit tính server, không tin client); webhook HMAC verify; idempotency key cho mọi charge; rate limit OAuth callback.
- [ ] Server Actions + API routes theo pattern hiện có (mẫu Stripe webhook + Wix cron).
- [ ] Token refresh + retry + `last_error` observability.
- [ ] UI states: connect/disconnect, loading, error, "đã kết nối" badge, test-connection button.
- [ ] Bilingual EN/VN cho mọi text mới.
- [ ] Sandbox trước → switch production bằng đổi env, không sửa code.
- [ ] Migration file chuẩn (tránh schema drift — viết migration thật, không db push tay).

## 4. Đề xuất AI/LLM leverage (tick cái muốn)
- [ ] (optional) Tự map service NailIQ ↔ Square category bằng AI khi sync lần đầu — ~$0.001/lần.
- [ ] (optional) Tóm tắt đối soát deposit bất thường (mismatch) gửi cảnh báo — Haiku.
> Mặc định KHÔNG bật gì ở đây trừ khi anh tick.

## 5. Tool automation (em tự dùng — không cần xác nhận)
- **Square MCP** (`mcp__claude_ai_Square__authenticate`) để test/đọc tài khoản Square sandbox trong lúc dev.
- Supabase MCP cho migration + types.
- `git` conventional commits từng module; cuối mở PR draft chờ duyệt.
- Vercel MCP cho env + deploy.

## 6. Tech stack
Giữ nguyên stack NailIQ: Next.js 16.2 + React 19.2 + Supabase (Postgres 17.6) + Server Actions + RLS. Thêm **Square Node SDK** (`square`). KHÔNG đổi gì khác chuẩn.

## 7. Module breakdown & thứ tự build
1. **P1.1** Migration `square_integrations` + RLS + types.
2. **P1.2** Square SDK client wrapper (`src/shared/integrations/square/`) — theo mẫu `wix/` + `lib/stripe.ts`.
3. **P1.3** OAuth flow: route `/api/square/oauth/start` + callback `/api/square/oauth/callback` + token refresh helper.
4. **P1.4** Dashboard settings UI: Connect/Disconnect/Test + feature flag.
5. **P2.1** Cột `bookings.square_payment_*` migration.
6. **P2.2** Deposit charge flow (hoàn thiện chỗ fallback OTP) + Square Payment Link.
7. **P2.3** Webhook `/api/square/webhook` + cập nhật payment_status + idempotency.
8. **P2.4** Refund + reconciliation script.
9. **P3.1** Catalog sync service → Square.
10. **P3.2** Customer sync client_profiles ↔ Square.
11. **(P4 sau)** POS/Terminal — SPEC riêng.

## 8. Deploy target
Vercel (env mới: `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_ENVIRONMENT=sandbox`, `SQUARE_WEBHOOK_SIGNATURE_KEY`). Supabase migration. Pilot trên 1 salon test (sandbox) trước khi bật salon thật.

## 9. Quyết định đã chốt
- Credential: **mỗi salon nối Square riêng qua OAuth** (per-tenant token).
- POS: **tách phase sau** (Phase 4).
- Môi trường: **Sandbox trước**, switch production sau.

## 10. Câu hỏi mở (xác nhận khi duyệt)
- Salon nào làm pilot? (đề xuất: tạo salon test riêng, hoặc Tech Nails vì đã có integration Wix sẵn)
- Anh đã có Square Developer account + tạo app để lấy `SQUARE_APP_ID`/secret chưa? (cần để chạy OAuth — nếu chưa, em hướng dẫn tạo)
- Deposit mặc định: % hay số tiền cố định, set per-salon hay per-service?

---
**Ước lượng Phase 1–3:** ~30–45h focus (~1 tuần). Phase 4 (POS) riêng, ~6 tuần + PCI.
