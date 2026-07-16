# SPEC — Unified AI Receptionist (web · phone · SMS), adaptive identity

**Trạng thái:** Huy duyệt hướng adaptive 2026-07-16. Module 1 đang làm.

## 1. Mục tiêu
**Một agent duy nhất** (bộ não `src/shared/voiceai/*` hiện có: `buildSystemPrompt` + `loadSalonContext`
+ `REALTIME_TOOLS` + `gpt-realtime-2`) phục vụ **3 đường vào**: web (WebRTC — đã có), **điện thoại**
(Twilio Voice — mới), SMS (nâng cấp — phase 2). Mọi hành động **thay đổi lịch** phải chứng minh
người thao tác **sở hữu số điện thoại** liên quan → không huỷ/đổi/đặt nhầm hoặc đặt giả.

## 2. Xác thực ADAPTIVE (step-up — chốt)
| Hành động | Yêu cầu |
|---|---|
| **Read-only** (hỏi slot trống, giá) | Không xác thực |
| **Mutation** (đặt / huỷ / đổi / group) | **Phải verify số sở hữu** trước khi thực thi |

Verify theo tầng, **server-authoritative** (không bao giờ tin AI tự nói "đã verify"):
1. **Caller-ID** (chỉ kênh phone): số gọi đến (`From`) đã được nhà mạng xác thực; nếu **khớp** số
   của hành động → cho phép, 0 mã. *(Module 2 thêm SHAKEN/STIR attestation để loại spoof.)*
2. **OTP** (mặc định cho web, hoặc khi số không khớp/attestation yếu): `request_otp` → khách nhận
   SMS → **đọc mã lại bằng miệng** → `verify_otp` → cấp `otp_session_id`. Mutation bắt buộc kèm
   session hợp lệ **cho đúng số sở hữu booking**.

Bảo mật chốt: huỷ/đổi tra `client_phone` **từ booking** rồi verify số đó — không tin số AI đọc.

## 3. Baseline (dùng lại)
`phone_otp_sessions` (UUID token, 15', consume 1 lần) + `/api/booking-otp/{send,verify}` (Twilio
Verify + guard rate-limit) — **tái dùng 100%**. Flag `voice_ai_enabled` (Beta, TẮT). Session
limit/tháng (200). Song ngữ (vi/en/fr/zh). No-log OTP/PII.

## 4. Module & thứ tự
1. **Module 1 (đang làm):** OTP gate server-side cho 4 mutation (confirm/cancel/reschedule/group)
   + 2 tool `request_otp`/`verify_otp` + tham số `otp_session_id` + caller-ID binding (sẵn cho
   phone) + prompt adaptive. **Test ngay trên web voice.** Đóng lỗ hổng "voice/tool POST không auth".
2. **Module 2:** cầu Twilio Voice ↔ OpenAI Realtime trên host persistent (Fly.io) + caller-ID/SHAKEN.
3. **Module 3:** Admin UI setup/voice (số Twilio, test call).
4. **Module 4 (tuỳ chọn):** SMS về chung agent.

## 5. Deploy / tech
Web: Vercel (đã có). Phone bridge: Node WS service riêng (Vercel serverless không giữ WS). Flag
TẮT tới khi verify. Không bật production cho tới khi Huy duyệt từng module.

## 6. Failure modes → mitigations
Huỷ/đổi nhầm → verify số-sở-hữu-booking · đặt giả → OTP cho confirm · spoof caller-ID → attestation
(M2) + OTP · WS trên serverless → host riêng (M2) · chi phí → session limit + đọc mã miệng · route
mutation không auth → gate voice_ai_enabled (đã có) + OTP gate (M1).
