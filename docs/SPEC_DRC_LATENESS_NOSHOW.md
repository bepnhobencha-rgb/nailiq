# SPEC — DRC Lateness & No-show UX ("Đồng hồ đếm ngược hệ quả")

Branch: `feat/drc-lateness-noshow-ux` · Surface: Receptionist Center (`/dashboard/[slug]/center`)
Ngày: 2026-06-14

## 1. Mục tiêu
Trên grid lễ tân: (a) block khách **đến trễ / chưa bắt đầu** phải đổi màu leo thang nhắc bấm *Bắt đầu dịch vụ*; (b) block **no-show** hiện màu báo động thay vì biến mất; (c) sửa 2 lỗ hổng tiền bạc đã phát hiện. Triết lý: màu sắc **gắn với hệ quả tiền** + nút 1-chạm, không phải màu câm.

## 2. Hai lỗ hổng logic đang sửa (đã verify trong code)
| Lỗ hổng | Hiện trạng | Quyết định của Huy |
|---|---|---|
| **A. Auto-mark không thu phí** | cron `auto_mark_no_shows()` (SQL) chỉ đổi status + bump no_show_count; KHÔNG gọi `chargeNoShowFee()` | Giữ KHÔNG auto-thu; gắn cờ **"Chưa thu — bấm để thu"** cho lễ tân duyệt |
| **B. Manual luôn tự thu** | `markNoShowBooking()` luôn best-effort `chargeNoShowFee()`, không cho chọn | Bật popup **"Thu $X / Miễn phí"** khi bấm (chỉ khi có thẻ + phí>0) |

## 3. Tính năng cốt lõi
### M1 — Lateness escalation trên block (`confirmed`/`pending` quá `start_time`)
Tier tính từ `minutesLate` so với ngưỡng salon `auto_no_show_minutes` (nếu salon tắt = NULL → mốc cố định 10/20 phút):
- 🟡 **Due** (0 → ⅓ ngưỡng): viền vàng thở + nút **Bắt đầu** inline.
- 🟠 **Late** (⅓ → gần ngưỡng): nền cam + badge đếm ngược *"Tự no-show 2:30"* (chỉ khi salon bật auto).
- 🔴 **Critical** (5′ cuối trước ngưỡng): đỏ nhấp nháy + nếu có thẻ: *"Sắp thu $X"*.
- Nút **Bắt đầu** inline → `updateBookingStatus(in_progress)`, gate `canChangeBookingStatus`, optimistic; bấm xong dừng đồng hồ.
- Reduced-motion: tĩnh, không nhấp nháy. Giữ overlay `isLate` cũ (in_progress quá giờ) nguyên vẹn.

### M2 — No-show "bia mộ ghost" trên grid
- Bỏ lọc `no_show` khỏi grid; render **vạch đỏ mỏng** ép mép slot, **dock lane phụ** nếu walk-in đã lấp chỗ (không che booking sống — vì `no_show` không giữ slot qua GIST).
- Badge: 💳 *"Đã thu $X"* / ⏳ *"Chưa thu $X — bấm để thu"* / *"Miễn"* / không thẻ = chỉ nhãn No-show.
- Nút 1-chạm: **Hoàn tác** (undo có sẵn) + **Thu phí** (nếu chưa thu) / **Miễn**.

### M3 — Backend: lựa chọn thu/miễn + thu tay
- `markNoShowBooking(slug, {…, chargeFee?: boolean})`: `true`→charge ngay; `false`→set `noshow_charge_status='waived'`; bỏ trống (auto-mark path không đổi) → giữ 'saved'.
- Action mới `chargeNoShowFeeManual(slug,{salonId,bookingId})` — role gate + `chargeNoShowFee()` cho bia mộ "chưa thu".
- Action mới `waiveNoShowFee(slug,{…})` — set `'waived'`, audit-log.
- `noshow_charge_status` vocab thêm `'waived'` (cột text, không CHECK enum → an toàn). Auto-mark giữ `'saved'` = "chưa thu".

## 4. Failure modes & mitigations
| Failure mode | Mitigation |
|---|---|
| Bia mộ che booking đã phục hồi slot | Render ghost mỏng + dock lane phụ; không chiếm width slot |
| Thu nhầm khách tới trễ | Auto-mark KHÔNG thu; manual phải chọn; undo decrement no_show_count |
| Double-charge khi bấm Thu nhiều lần | `chargeNoShowFee` idempotent (`noshow:{id}` key + status guard 'charged') |
| Đếm ngược lệch giờ | So sánh UTC ms (`start_time_utc`/`nowIso`) — đã đúng, không dùng device tz |
| nail_tech bấm Start/charge | Gate `canChangeBookingStatus` / `canMarkNoShow` |
| Countdown gây re-render nặng | Tận dụng tick 60s sẵn có (hạ 30s); chỉ block trễ mới tính |

## 5. Không đụng / giữ nguyên
- Cổng card-on-file lúc booking (`noShowCardDecision`) — thuộc nhánh payments, không sửa.
- Auto-mark SQL cron — không đổi hành vi (vẫn không thu); chỉ UI đọc trạng thái.
- Realtime/refresh (`calendarRefreshNonce`), overlap GIST, role helpers — dùng lại.

## 6. Thứ tự build
1. M3 backend (param + 2 action + 'waived') + test thu/miễn/idempotent.
2. M1 visual escalation + inline Start (load `auto_no_show_minutes` + `minutesLate` vào GridBooking).
3. M2 ghost tombstone + collision/dock.
4. i18n EN/VI cho mọi nhãn mới; build + lint + E2E; preview link (revenue path → preview-first, merge sau khi Huy OK).

## 7. Out of scope (đề xuất sau, chờ Huy)
- "Arrived/Check-in" state riêng (dừng đồng hồ mà chưa Start) — Arrival Intelligence; cần cột status mới.
- Refund phí đã thu (chỉ deposit có refund hiện tại).
