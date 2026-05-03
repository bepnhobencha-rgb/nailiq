# PRE-FLIGHT v2 — Append to Receptionist Center prompt

> Append toàn bộ section này vào CUỐI prompt Receptionist Center gốc, SAU section "DELIVERABLES — final checklist" trong Pre-flight v1.
> Reference design: `receptionist-center-mockup.html` (standalone HTML mockup) — Cursor đọc file này để hiểu visual + interaction intent.
> Mọi spec dưới đây ADDITIVE với Pre-flight v1. Không override.

---

## CHERRY-PICKS — 6 features bổ sung từ design review

Sau khi review mockup, lock thêm 6 features vào V1 scope. Tất cả có data foundation thật, không vaporware. Tổng estimate ~5-6h work, fit trong sprint Receptionist Center.

### 1. Top Status Pill (header right)

**Mục đích**: Receptionist liếc 1 lần biết tiệm đang busy/calm.

**Spec**:
- Component: `StatusPill.tsx` đặt trong header của `ReceptionistCenter`
- Data:
  - `waiting` = count bookings WHERE source='walkin' AND status='waiting'
  - `inProgress` = count bookings WHERE status='in_progress' AND date = selected date
- Render text: `{waiting} CHỜ · {inProgress} ĐANG PHỤC VỤ`
- 3 states (auto-detect):
  - `calm` (xanh): tổng ≤ 2
  - `default` (xám): 3-5
  - `busy` (cam pulsing): tổng ≥ 6 HOẶC waiting ≥ 4
- Update: re-derive sau mỗi realtime event hoặc state change

**Why real**: Cả 2 metric đã có trong query loader. Pure derivation, không cần schema mới.

---

### 2. Urgent Badge cho Walk-in Queue Item

**Mục đích**: Highlight khách đã chờ lâu HOẶC khách vội (note flag).

**Spec**:
- Trong `WalkinQueueSidebar` render từng `QueueItem`
- Detection logic:
  ```ts
  const waitMin = differenceInMinutes(new Date(), item.joined_queue_at);
  const noteFlag = item.staff_request_note &&
    /vội|urgent|gấp/i.test(item.staff_request_note);
  const isUrgent = waitMin >= 20 || noteFlag;
  ```
- Visual: queue item border-color đỏ nhạt + flag nhỏ "⚡ URGENT" cạnh tên
- Re-evaluate mỗi 60s (cùng interval với now-line update) để waitMin tăng theo thời gian thực
- KHÔNG sort lại — giữ FIFO theo `joined_queue_at`. Urgent = visual hint, không reorder

**Why real**: `joined_queue_at` đã có trong schema (Pre-flight v1). `staff_request_note` đã có. Pure UI logic.

---

### 3. Ghost Preview Block (assign mode)

**Mục đích**: Receptionist thấy TRƯỚC khi click vị trí + width của block sẽ tạo. Reduce misclick.

**Spec**:
- Khi `assignMode === true` (đã chọn 1 walk-in để assign):
- Mouse enter slot cell trên grid → render ghost block:
  - Position: `left = slotIndex * SLOT_WIDTH`
  - Width: `Math.ceil((service.duration_minutes + service.buffer_minutes) / 30) * SLOT_WIDTH`
  - Style: dashed gold border, 18% gold fill, semi-transparent
  - Text: `{walkin.name} · {service.duration_minutes}m`
- Mouse leave slot → remove ghost
- Touch device (iPad): chỉ show ghost ở slot vừa tap, clear sau 1.5s nếu không click confirm
- Implementation: 1 ghost element per row, manage qua state (không React DOM thrash)

**Why real**: Pure CSS + mouse event. Không cần backend.

---

### 4. Conflict Detection Visual + Prevention

**Mục đích**: Block assign vào slot trùng booking khác. Cảnh báo trực quan TRƯỚC khi click.

**Spec**:
- Trong assign mode, khi compute ghost position → check conflict:
  ```ts
  function checkConflict(staffId, startMin, endMin, salonBookings) {
    return salonBookings.find(b =>
      b.staff_id === staffId &&
      b.status !== 'cancelled' &&
      b.status !== 'waiting' &&
      b.start_time_utc < endTimeUtc &&
      b.end_time_utc > startTimeUtc
    );
  }
  ```
- 3 conflict states:
  - **OK**: ghost gold, text `{name} · {duration}m`
  - **Trùng booking**: ghost ĐỎ, text `⚠ Trùng {conflict.client_name}`
  - **Quá giờ đóng** (endSlot > 20:00): ghost đỏ, text `⚠ Quá giờ đóng`
- Click conflict slot:
  - KHÔNG call server action
  - Show shake toast đỏ: `⚠ Slot trùng với {client_name}`
  - 2s auto-dismiss
- Server action `assignWalkinToSlot` GIỮ NGUYÊN conflict check (Pre-flight v1) — UI là first-line defense, server là last-line

**Why real**: Booking data đã có trong loader. Defense-in-depth: client-side cho UX, server-side cho race condition.

---

### 5. Undo Toast cho Assign

**Mục đích**: Assign nhầm tech/slot là common. Undo trong 5s window = receptionist confidence cao, click nhanh không sợ.

**Spec**:
- Sau khi `assignWalkinToSlot` thành công → show undo toast bottom-center:
  - Icon ✓ + message: `{walkin.name} → {staff.name}`
  - Sub-line: `{startTime in salon tz} · {service.name}`
  - Button "Hoàn tác" + countdown "5s → 1s"
- Click "Hoàn tác" trong 5s:
  - Call new server action `undoWalkinAssignment(booking_id)`:
    ```ts
    UPDATE bookings SET
      status = 'waiting',
      staff_id = NULL,
      start_time_utc = NULL,
      end_time_utc = NULL
    WHERE id = booking_id
      AND source = 'walkin'
      AND status = 'confirmed'  -- only undoable if not started
    ```
    - Nếu rows updated = 0 → show toast "Đã bắt đầu phục vụ, không thể hoàn tác"
- Auto-dismiss sau 5s
- Chỉ 1 undo toast tại 1 thời điểm (replace nếu có cái cũ)

**Why real**: Schema cho phép null fields (Pre-flight v1). Server action 5 dòng SQL. Toast component reuse pattern existing.

**Edge case**: Nếu user đã start booking trong 5s window → undo phải fail gracefully. Đó là lý do WHERE clause check `status = 'confirmed'`.

---

### 6. Call Customer Link trong Drawer

**Mục đích**: Receptionist cần gọi khách (confirm, hỏi đến đâu rồi, etc.) — 1 tap mở Phone app trên iPad.

**Spec**:
- Trong booking detail drawer, nếu `booking.client_phone IS NOT NULL`:
- Render button đầu actions list:
  ```tsx
  <a
    href={`tel:${cleanPhone(booking.client_phone)}`}
    className="drawer-btn call"
  >
    📞 Gọi {formatPhone(booking.client_phone)}
  </a>
  ```
- Helper `cleanPhone`: strip non-digits, keep leading `+`
- Helper `formatPhone`: format US/CA pattern `(604) 555-0142` cho display
- Khi `client_phone IS NULL` (walk-in không nhập phone) → KHÔNG render button
- Style: surface bg + gold text + gold border, không CTA primary (không phải action chính)

**Why real**: `tel:` link is web standard. iPad Safari mở FaceTime/Phone app native. Zero deps.

---

## SCOPE GUARD — features REJECT khỏi Receptionist Center V1

Reference: `decisions-log.md` entry 2026-05-02 "Parking lot tổng hợp — AI features + Payment + Luxury widgets defer post-PMF".

KHÔNG build (kể cả "easy" hoặc "5 phút"):
- AI Smart Suggest (gợi ý slot)
- Auto-assign mode
- Workload bar / load percentage per staff
- Wait time prediction cho khách trong queue
- VIP tag / customer habits / AI insights card
- Drag-to-reschedule, resize block
- Bulk multi-assign
- Square/Clover payment integration trực tiếp trong drawer
- Marketing automation (rotating SMS fill empty slots)
- AI Voice Receptionist pill / status indicator
- Sentry "system protection" badge
- Reassign staff trong drawer (trừ cancel + re-add)
- Move time trong drawer (trừ cancel + re-add)

Khi feedback push những thứ trên → reference decisions-log entry, không re-debate.

---

## UPDATED COMPONENTS LIST

Bổ sung vào danh sách components Pre-flight v1:

```
src/components/receptionist/StatusPill.tsx
src/components/receptionist/UndoToast.tsx
src/components/receptionist/GhostBlock.tsx
src/shared/lib/phoneFormat.ts          (formatPhone, cleanPhone helpers)
src/shared/lib/queueUrgency.ts         (isUrgent detection logic)
src/shared/lib/conflictCheck.ts        (checkConflict — shared client + server)
```

`conflictCheck.ts` MUST be reusable cho cả client (UI feedback) lẫn server (`assignWalkinToSlot` action) → pure function, no React, no Supabase imports. Just compute logic over arrays.

---

## UPDATED SERVER ACTIONS

Bổ sung 1 action mới vào `src/shared/dashboard/receptionistActions.ts`:

### undoWalkinAssignment

Inputs: `booking_id`

Logic:
```sql
UPDATE bookings SET
  status = 'waiting',
  staff_id = NULL,
  start_time_utc = NULL,
  end_time_utc = NULL
WHERE id = $1
  AND source = 'walkin'
  AND status = 'confirmed';
```

Returns:
- `{ ok: true }` if rows updated > 0
- `{ ok: false, reason: 'already_started' }` if rows updated = 0

UI handles `ok: false` by showing toast "Đã bắt đầu phục vụ, không thể hoàn tác".

---

## UPDATED VISUAL TOKENS

Bổ sung tokens vào theme (nếu chưa có trong `src/shared/theme/tokens.ts`):

```ts
// Status pill states
'--status-pill-busy-bg':   'rgba(255, 149, 0, 0.08)',
'--status-pill-busy-fg':   '#FFB84D',
'--status-pill-busy-border': 'rgba(255, 149, 0, 0.4)',
'--status-pill-calm-fg':   '#4EBE94',
'--status-pill-calm-border': 'rgba(14, 138, 95, 0.35)',

// Urgent queue item
'--urgent-fg':     '#FF6B6B',
'--urgent-bg':     'rgba(255, 107, 107, 0.06)',
'--urgent-border': 'rgba(255, 107, 107, 0.4)',

// Ghost block
'--ghost-ok-bg':       'rgba(212, 175, 55, 0.18)',
'--ghost-conflict-bg': 'rgba(255, 59, 48, 0.18)',
'--ghost-conflict-fg': '#FFB3AF',
```

Reference values khớp mockup. Cursor có thể adjust nhẹ để fit existing token system, nhưng GIỮ semantic (busy = warm, calm = green, urgent = red, ghost-ok = gold).

---

## UPDATED MANUAL TEST CASES

Add vào danh sách 8 test cases gốc:

9. Status pill auto-update khi:
   - Add walk-in vào queue → "CHỜ" tăng 1
   - Assign walk-in → "CHỜ" giảm 1
   - Mark booking in_progress → "ĐANG PHỤC VỤ" tăng 1
   - Mark complete → "ĐANG PHỤC VỤ" giảm 1
   - Có 6+ active total → pill chuyển busy (cam pulse)

10. Urgent badge:
    - Add walk-in mới → KHÔNG urgent
    - Wait 21 phút (hoặc adjust `joined_queue_at` trong DB) → badge xuất hiện sau next 60s update
    - Add walk-in với note "khách vội" → urgent NGAY lập tức

11. Ghost preview:
    - Click Assign → hover slot trống → ghost gold xuất hiện đúng width
    - Hover slot trùng booking → ghost ĐỎ + text "⚠ Trùng {name}"
    - Hover slot cuối ngày (overflow) → ghost ĐỎ + "⚠ Quá giờ đóng"
    - Mouse leave → ghost biến mất

12. Conflict prevention:
    - Click slot conflict → toast đỏ shake, KHÔNG navigate, walk-in vẫn trong queue
    - Click slot OK → assign thành công

13. Undo toast:
    - Assign thành công → toast đáy + countdown 5s
    - Click "Hoàn tác" trong 5s → walk-in về queue, block biến mất
    - Wait 6s → toast tự dismiss, không undo
    - Mark in_progress booking trong 5s window → click undo → toast error "đã bắt đầu phục vụ"

14. Call link:
    - Drawer cho booking có phone → button "📞 Gọi (604) 555-0142"
    - Click trên iPad → mở Phone app
    - Drawer cho walk-in không phone → KHÔNG có button call

---

## DELIVERABLES — UPDATED CHECKLIST

Sau implementation, report thêm:

8. Screenshot Receptionist Center với status pill ở 3 trạng thái (calm / default / busy)
9. Screenshot ghost preview cả OK lẫn conflict state
10. Screenshot undo toast với countdown visible
11. Video clip 30s flow: add walk-in → urgent badge xuất hiện sau 20min (có thể demo bằng cách inject `joined_queue_at` cũ) → click Assign → hover conflict → hover OK → click → undo toast → click hoàn tác
12. `conflictCheck.ts` unit test (pure function, easy to test): ít nhất 5 cases (no conflict, exact overlap, partial overlap start, partial overlap end, contained)

---

## END OF PRE-FLIGHT v2

Tổng spec Receptionist Center V1 = Pre-flight v1 + v2.
Reference design = `receptionist-center-mockup.html`.
Reject list = `decisions-log.md` entry 2026-05-02 parking lot.

3 sources of truth — Cursor verify trước khi viết line đầu tiên.
