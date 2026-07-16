# NailIQ — Pilot Readiness Report

**Ngày đánh giá:** 2026-07-16
**Merge commit (đánh giá trên):** `7dfe7705` (PR #766) trên `main`
**Kết luận:** ✅ **PILOT READY** cho **3–5 tiệm nail** (kèm checklist cấu hình từng tiệm §7).

> Ngưỡng pilot KHÔNG phải "toàn bộ E2E xanh". Ngưỡng là: các luồng nghiệp vụ critical hoạt
> động đúng, có bảo vệ dữ liệu/thanh toán, và không có bug Critical/High mở. Test debt
> (landing copy, Receptionist Center mobile/chromium, responsive) **không chặn pilot**.

## 1. Required checks (HEAD `7dfe7705`)
| Check | Trạng thái |
|---|---|
| Smoke (required) | ✅ pass |
| Build & Type Check | ✅ pass |
| Security Audit | ✅ pass |
| Secret scan | ✅ pass (0 secret trong diff; guardProduction fail-closed) |

## 2. Public booking
| Luồng | Kết quả | Bằng chứng |
|---|---|---|
| OTP-OFF hoàn tất booking | ✅ | Smoke `guest can actually BOOK` — đọc row ra khỏi Postgres, đúng salon/service/staff/name/time |
| OTP-ON (gate OTP → service → confirm) | ✅ | `booking-otp :: full booking completes after gate OTP` |
| Wrong OTP bị chặn | ✅ | `booking-otp :: rejects a wrong code` — error + service-tile count 0 (flow khoá) |
| Correct OTP mở gate | ✅ | cùng test — `000000` → service unlock |
| Đổi phone sau verify → re-lock | ✅ | `booking-otp :: editing the phone after verify re-locks the gate` |
| Không double booking | ✅ | GIST `bookings_no_overlap` + advisory lock + in-tx overlap check; `booking-conflict.spec` (2 overlap → 1 pass, 1 `23P01`/`23505`) |
| tel:// A2P fallback ở gate OTP | ✅ | `booking-otp :: tel:// call-to-book link` (khôi phục #762) |

## 3. Group booking (salon OTP-ON)
| Luồng | Kết quả | Bằng chứng |
|---|---|---|
| Gate verify trước khi mở group | ✅ | group toggle sau `flowReady = gateReady && gateOtpDone` |
| KHÔNG OTP lần hai sau Confirm | ✅ | `otp-gate :: group books without a second OTP` (#763 fix); `#otp-code` count 0 |
| Chỉ MỘT SMS request | ✅ | cùng test: `sendCount === 1` |
| Group booking hoàn tất đúng 1 lần | ✅ | `booking-group-success` + mã `#GRP-xxxxxxxx-XXXX` |
| Không duplicate / double charge | ✅ | OTP validate TRƯỚC RPC insert; dedup idempotency-key (UNIQUE) + GIST; card tokenize 1 lần, save sau `res.ok` |

## 4. Authentication & tenant isolation
- `/dashboard/**` chưa login → 307 `/login`; `/superadmin/**` → 307 `/superadmin/login` (proxy `src/proxy.ts`, verify production).
- Tenant isolation ở **data-layer**: `resolveSalonForDashboard(slug)` chỉ trả context nếu user là `salon_members` của slug đó; mutation verify `row.salon_id === salon.id`, query `.eq("salon_id", salon.id)`. Owner salon A không resolve được dashboard salon B.
- RLS `client_profiles` PII: SEALED (revoke anon/authenticated SELECT + per-phone RPC).

## 5. Production status
- Deploy trên `7dfe7705`; routes: home/register/salon 200, slug lạ 404, dashboard/superadmin redirect đúng, public booking render.
- **0 lỗi 500 mới** (Vercel runtime errors trống). Không migration. Không ghi production. Không production secret trong CI.
- Full E2E chromium: **200 / 184 pass / 12 fail / 5 skip** — 12 fail = 100% test debt (landing-funnel 7 #748 + Receptionist Center chromium 5 #749). **0 fail mới.**

## 6. Critical / High mở
**Không có Critical. Không có High.** Issue OTP đã đóng: #754, #762, #763.

## 7. Checklist cấu hình BẮT BUỘC từng tiệm pilot (trước go-live)
- [ ] `phone_otp_enabled` — xác nhận đúng ý tiệm.
- [ ] Số điện thoại tiệm (`salon_phone`) đã set → tel:// fallback hoạt động.
- [ ] `email_links_enabled` — **BẬT** để có kênh OTP thứ 2 (quan trọng khi A2P chưa duyệt).
- [ ] Email hỗ trợ hợp lệ.
- [ ] Twilio/A2P hoặc sender đã đăng ký/hợp lệ (SMS "sent" ≠ "delivered" nếu A2P chưa duyệt).
- [ ] SMS consent wording đúng (CASL/TCPA).
- [ ] Booking policies, service, staff, availability đã cấu hình.
- [ ] Square configuration (nếu dùng no-show card / thanh toán).
- [ ] Gift card configuration (nếu tiệm dùng).
- [ ] 1 booking test với dữ liệu pilot **được chủ tiệm cho phép** → xoá/đánh dấu rõ sau đó.
- [ ] KHÔNG dùng credential tiệm này cho tiệm khác.

## 8. Giới hạn & rollback
- **Giới hạn pilot:** 3–5 tiệm. Không mở rộng trước khi có phản hồi.
- **Rollback:** Vercel Instant Rollback về deploy production READY trước đó (các deploy gần nhất là `isRollbackCandidate: true`); không có migration nên rollback code là đủ, không cần hoàn tác DB.
- **Theo dõi phản hồi:** chủ dự án (Huy) theo dõi Vercel runtime errors + booking thực tế của tiệm pilot; bất thường → rollback + điều tra.

## 9. Backlog KHÔNG chặn pilot
Landing-funnel stale copy (#748) · Receptionist Center chromium test debt (#749) · RC mobile test debt (#758) · superadmin mobile race (#755) · "14-day free trial" copy · server-recompute giá trước khi nối deposit (Low) · cấu hình WAF rate-limit · comment header smoke cũ.

## Giới hạn đánh giá (thành thật)
Verify DB "trực tiếp Supabase Local" không chạy được trên máy đánh giá (không có Docker). Bằng
chứng DB-level lấy từ **CI E2E** (Smoke đọc booking ra khỏi Postgres; otp-gate/booking-conflict
assert row + GIST). Không giảm giá trị kết luận nhưng ghi rõ để minh bạch.
