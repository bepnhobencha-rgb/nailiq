# WORK ORDER — giao Claude Code làm trọn (NailIQ)

> Dán nguyên file này cho Claude Code. Làm theo thứ tự. **Mỗi mục = 1 PR riêng**
> (CLAUDE.md: "One PR per logical change"). `npm run typecheck` + `npm run build`
> xanh trước khi mở PR. Mở **PR draft**, KHÔNG tự merge. Đường booking/tiền/khách
> = **preview-first** (tạo preview URL + share-bypass cho PM duyệt). Áp migration
> vào prod qua Supabase MCP trong cùng PR. **KHÔNG gọi Twilio thật trong test.**

## 0. Bối cảnh — 3 nhánh ĐÃ viết xong (chỉ cần review + merge)

Các nhánh này đã có code + typecheck xanh; người vận hành sẽ push/mở PR. Claude Code
**đọc để không làm trùng**, và rebase công việc mới lên trên chúng:
- `feat/booking-calendar-availability` — lịch bắt đầu từ tuần hiện tại, chấm 3 màu theo số chỗ, nút "ngày gần nhất còn chỗ".
- `fix/duplicate-confirmation-email` — sửa `currency`→`currency_code` + claim-before-send chống gửi trùng (migration `booking_notifications_confirmation_once` ĐÃ áp prod).
- `fix/minh-a2p-sms-guardrail` — guardrail A2P (US chưa đăng ký → email), mới wire **winback**. Stopgap: Hi-Lite `sms_outbound_enabled=false` đã áp prod.

Tài liệu kiến trúc bắt buộc đọc: `docs/SPEC-minh-learning-loop.md`, `docs/decisions.md` (2 entry ngày 2026-06-19).

---

## 1. Hoàn tất A2P guardrail cho MỌI agent  🔴 ưu tiên

**Vì sao:** mới chỉ `agentWinback` được wire. Các agent khác vẫn có thể gửi US SMS khi chưa A2P.

**Việc:** dùng đúng pattern đã có trong `src/shared/winback/agentWinback.ts` (thêm `sms_a2p_registered` vào select; truyền `smsA2pRegistered` + `customerPhone` vào `resolveCustomerChannel`). Áp cho:
- `src/shared/firstvisit/agentFirstVisit.ts`
- `src/shared/rebook/agentRebook.ts`
- agent `vip_care`
- mọi đường nhắc lịch (`src/app/api/cron/reminders/*`, `src/shared/reminders/*`)
- `src/shared/dashboard/sendReviewRequest.ts`

**Acceptance:** với salon US + `sms_a2p_registered=false`, MỌI agent fallback email (hoặc skip nếu không có email), KHÔNG gửi SMS. Non-US / đã A2P không đổi. Thêm 1 unit test cho `resolveCustomerChannel` (US+chưa A2P→email; CA→sms; đã A2P→sms). KHÔNG gọi Twilio thật.

---

## 2. Admin UI cho A2P + kênh gửi  🟠

**Vì sao:** không hardcode — owner không rành code vẫn tự bật/tắt được.

**Việc:** trong `/dashboard/[slug]/settings` thêm khu "Tin nhắn & Email":
- Badge trạng thái: A2P `Đã đăng ký / Chưa đăng ký`, SMS `Bật/Tắt`, Email `Bật/Tắt`.
- Toggle `sms_outbound_enabled`, `email_outbound_enabled`; nút lưu (server action, check `salon_members` owner/admin).
- Dòng giải thích: "Tiệm ở Mỹ cần đăng ký A2P 10DLC trước khi gửi SMS; trong lúc chờ, hệ thống tự dùng email."

**Acceptance:** đổi toggle → reflect ngay ở hành vi agent. RLS + membership check server-side.

---

## 3. Minh Learning Loop — Bước 1: kho bài học `minh_lessons`  🟠

Theo `SPEC-minh-learning-loop.md` §3A.

**Migration:** bảng `minh_lessons (id, salon_id null=global, scope, condition jsonb, rule text, source, confidence numeric, active bool, created_at)`. RLS: chỉ service-role ghi; owner đọc của salon mình.

**Code:** `src/shared/ai/lessons.ts` — `getLessons(salonId, scope)` (cache + `unstable_cache`/tags). Agent đọc lesson khớp context TRƯỚC khi hành động.

**Seed lesson #1:** chuyển guardrail A2P thành 1 record (`scope='channel'`, condition `{country:'US', a2p:false}`, rule `prefer_email`) — code vẫn là backstop.

**Acceptance:** thêm/sửa lesson trong DB đổi hành vi agent mà không sửa code.

---

## 4. Minh Learning Loop — Bước 2: nối tín hiệu phản hồi  🟠

Theo SPEC §3B.

- **Lỗi gửi:** đọc `booking_notifications` + webhook Twilio (status `failed`/error 30034) → nếu một salon/kênh fail vượt ngưỡng → tự tạo lesson "né kênh X" + hạ confidence.
- **Kết quả:** từ `ai_actions_log.outcome` (outcome tracker đã có) → agent/segment converted thấp → giảm tần suất.
- **Chi phí:** cộng dồn cost gửi theo kênh → cảnh báo digest.

**Acceptance:** mô phỏng 1 loạt fail → hệ thống tự sinh lesson né kênh; agent lần sau tôn trọng. Có test.

---

## 5. Minh Learning Loop — Bước 3: duyệt + BÁO OWNER  🔴 (Huy nhấn mạnh)

Theo SPEC §3D + §3E. **Đây là phần Huy quan tâm nhất: không để việc "chờ duyệt" nằm im.**

**Migration:** `approval_requests (id, salon_id, action_type, summary, payload jsonb, urgency 'urgent'|'normal', status 'pending'|'approved'|'declined'|'expired', expires_at, decided_by, decided_at, created_at)`.

**Phân tầng:** hành động tốn tiền / gửi hàng loạt / khó đảo (gửi US SMS, charge no-show, đổi giá) → tạo `approval_request` thay vì chạy luôn.

**Báo owner (BẮT BUỘC, qua kênh đáng tin):**
- **Email luôn gửi** (tôn trọng A2P guardrail — đừng báo owner US qua SMS bị chặn) + chuông/badge in-app.
- Email kèm **nút Đồng ý / Từ chối** = link token an toàn (server action verify token + membership) → duyệt ngay trong mail, khỏi mở dashboard.
- *Gấp* → báo ngay; *không gấp* → gom vào digest 21:00 "X việc chờ duyệt".
- Gom nhiều việc 1 thông báo; nhắc lại 1 lần; **quá hạn → mặc định an toàn (skip)**.
- Ghi audit; owner hay từ chối loại nào → feed lesson "giảm đề xuất loại đó".

**Acceptance:** tạo 1 approval_request → owner nhận email có nút duyệt → bấm Đồng ý → hành động chạy + log; bấm Từ chối → skip + log; để quá hạn → auto-skip. Trang "việc chờ duyệt" trong dashboard. KHÔNG gửi SMS/email thật tới người thật trong test (dùng địa chỉ test).

---

## 6. QA verify cuối  🟢

Chạy `docs/qa/booking-flow-test-request.md` trên preview (desktop 1280 + mobile 390) cho: luồng booking (gồm lịch mới), không còn email trùng, A2P fallback email. Lưu report vào `docs/qa/`. Loại 3 bẫy false-positive (cache, timezone tiệm, flake) trước khi báo bug.

---

## Quy ước chung (CLAUDE.md — bắt buộc)
- Stack: Next 16 + React 19 + Supabase + Tailwind v4 + Framer Motion. Server Actions cho mọi mutation (không thêm REST route). `salon_members` check trong mọi mutation (RLS là backstop).
- Không hardcode (text/giá/cờ đọc từ DB/Settings/env). Bilingual EN/VI.
- `npm run typecheck` + `npm run build` xanh trước PR. PR **draft**, 1 PR / 1 mục. Preview-first cho booking/tiền/khách. Áp migration prod qua Supabase MCP cùng PR.
- **E2E/test KHÔNG gọi Twilio thật** (wrapper kill-switch + số 555). Không set `DISABLE_OUTBOUND_SMS` trên prod.
- Sau mỗi mục: cập nhật `docs/decisions.md` (1 entry) khi là quyết định kiến trúc.

## Thứ tự đề xuất
1 → 2 → 3 → 4 → 5 → 6. (1,2 độc lập, làm trước/song song. 3 trước 4,5. 5 là phần "báo owner" Huy nhấn mạnh.)
