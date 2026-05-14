# QA Re-Sweep — Group Booking Final Check

Ngày: 2026-05-12 (sweep thứ 3)
Phạm vi: re-test 3 bug còn mở + hunt new bug + edge cases

## Tổng kết: 16/17 báo cáo gốc đã FIX, 1 còn mở, phát hiện 3 bug MỚI

---

## ✅ Đã FIX hoàn toàn (so với báo cáo trước)

### P2 #9 — Phone hiển thị `+1` prefix → ✅ FIX
Trước: `(604) 555-1234`. Giờ: `+1 (604) 555-1236` — full NANP format khớp placeholder.

### P2 #11 — Postal code uppercase → ✅ FIX
Hiển thị `V3R 2A1` đúng cách (trước đó từng thấy `V3r 2a1` — có thể fix qua salon data hoặc CSS).

### P2 #15 — Image responsive → ✅ MOSTLY FIX
3/4 ảnh giờ có `srcset` + `sizes` đúng (300×450 cho slot 179×134 retina). Chỉ ảnh hero thiếu srcset nhưng cấp bậc thấp.

### Edge cases verify TỐT
- **Edit/Sửa link**: back từ step 2 → step 1 giữ nguyên phone, size, mode ✓
- **Triple-click protection**: click submit 3 lần nhanh chỉ ra **1 network call** — `if (submitting) return;` guard hoạt động đúng
- **3-member submit**: max group size = 3 với 3 thợ khác nhau + 3 service khác nhau → success, total 70 min (max), $95 (sum)
- **XSS guard**: `<script>alert(1)</script>` trong name field render literal, không execute
- **Tab navigation**: tất cả focusable đều có id rõ ràng (`booking-language-vi`, `group-shared-date-input`, `group-member-0-name-input`, ...) — keyboard nav OK

---

## ⚠️ Bug còn mở từ báo cáo trước (1 issue)

### NEW từ trước — `<html lang>` không sync khi switch UI lần đầu
Load trang `https://www.nailiq.ca/liam-nails?mode=group`:
- Cookie `nq-booking-lang=en` ✓
- UI text rendered EN ✓
- BUT `document.documentElement.lang === "vi"`

Sau khi user explicitly click EN toggle: `htmlLang` update đúng. Vấn đề chỉ ở first render. Screen reader sẽ phát âm EN text theo phonetic Việt → tệ accessibility.

**Fix**: render `<html lang>` server-side dựa vào cookie `nq-booking-lang`, hoặc `useEffect(() => { document.documentElement.lang = locale; }, [locale]);` chạy ngay khi mount.

---

## 🚨 BUG MỚI phát hiện (3 issues)

### 🆕 P1 #18 — Step 1 không validate phone format
Gõ `(604) 555` (6 digits, không phải NANP hợp lệ) → click "Continue" → **chuyển sang step 2**.
- Client check: `sizeNextEnabled = primaryPhone.trim().length > 0` — chỉ check non-empty
- Sticky summary step 2 hiển thị `Primary contact: (604) 555 · 2`
- User fill đủ step 2, submit → server reject với `invalid_input` → UI banner generic
- Wasted effort + user confusion

**Fix**: dùng `validateGuestPhone` từ `src/shared/booking/validateGuestPhone.ts` ngay tại step 1. Set `aria-invalid` + show "Số điện thoại không hợp lệ" inline khi click Continue.

### 🆕 P1 #19 — Step 1 không validate email format
Gõ `not-an-email` (không có `@`) → "Continue" → **chuyển sang step 2**.
- Sticky summary step 2: `Primary contact: (604) 555 · not-an-email · 2`
- Submit → server reject `invalid_input` → UI banner generic

**Fix**: dùng `isValidEmailFormat` từ `src/shared/lib/emailFormat.ts` ngay tại step 1.

### 🆕 P1 #20 — Banner "Couldn't book the group. Please try again." quá generic
Khi server trả `invalid_input` (do bất cứ lý do nào: phone, email, name, time, date), UI fallback về `groupCopy.serverError`:
> *"Couldn't book the group. Please try again."*

User không biết:
- Trường nào sai
- Sai vì lý do gì (format, độ dài, ký tự đặc biệt)
- Cần sửa ở step nào (1 hay 2)

Người dùng có thể click submit lặp lại mà vẫn fail.

**Fix**: server action `submitGroupBooking` cần return reason chi tiết hơn — ví dụ `invalid_phone`, `invalid_email`, `invalid_name`, `invalid_time`, `invalid_date` thay vì gộp tất cả về `invalid_input`. UI map từng reason sang message cụ thể trong `groupCopy`.

### 🆕 P3 (Trivial) — Cookie reset từ `en` → `vi` sau Continue click (intermittent)
Reproduce 1 lần trong test:
- Load page với cookie `nq-booking-lang=en`, UI EN
- Click Continue (step 1 → step 2)
- Cookie biến thành `nq-booking-lang=vi`, UI step 2 hiển thị VI

Subsequent tests cùng action không reproduce. Có thể là race condition trong cookie write giữa LanguageToggle component và step transition. Khó tái lập nhưng đáng theo dõi.

---

## So sánh trước/sau (cập nhật cuối)

| ID | Severity | Status sau sweep cuối |
|----|----------|----------|
| #1 P0 | Blocker `duplicate_submission` | ✅ FIX |
| #2 P1 | Step 1 silent fail | ✅ FIX (aria-invalid + role=alert) |
| #3 P1 | Date past | ✅ FIX (min/max) |
| #4 P1 | Time outside hours | ✅ FIX (min=10:00 max=19:00) |
| #5 P1 | 1/4 role=alert | ✅ FIX (7/7) |
| #6 P1 | Date/time no label | ✅ FIX (visible label + for=id) |
| #7 P1 | "khung giờ bị đặt mất" misleading | ✅ FIX (inline staff-already-chosen) |
| #8 P1 | 2 banner mâu thuẫn | ✅ Resolved by #7 |
| #9 P2 | Phone không có +1 | ✅ FIX |
| #10 P2 | "Hôm nay" leak EN | ✅ FIX |
| #11 P2 | postal lowercase | ✅ FIX |
| #12 P2 | service grid overlap | ✅ FIX |
| #13 P2 | lang switch reset mode | ✅ FIX (URL persist) |
| #14 P2 | Tap target 40px | ✅ FIX (44px) |
| #15 P2 | Image oversized | ✅ MOSTLY FIX (srcset + lazy) |
| #16 P2 | Emoji no aria-label | ✅ FIX |
| #17 P2 | img no aria-hidden | ✅ FIX |
| Older NEW | `<html lang>` không sync | ⚠️ vẫn mở |
| **🆕 #18 P1** | **Phone format không validate step 1** | ⚠️ MỚI |
| **🆕 #19 P1** | **Email format không validate step 1** | ⚠️ MỚI |
| **🆕 #20 P1** | **Banner error quá generic** | ⚠️ MỚI |
| 🆕 P3 | Cookie reset intermittent | ⚠️ MỚI (khó tái lập) |

**Tổng cộng**: 16/17 báo cáo gốc FIX, +1 issue cũ vẫn mở, +3 bug mới phát hiện (3 P1 + 1 P3 intermittent).

Group booking production hiện **không có blocker**, không có P0. Submit nhóm 2 và 3 người đều thành công thực tế. Cải tiến cần tập trung vào:
1. Validate phone + email format ngay step 1 thay vì để fail ở submit
2. Map server error reason → user-facing message cụ thể (thay vì generic "Couldn't book")
3. Đồng bộ `<html lang>` với UI locale
