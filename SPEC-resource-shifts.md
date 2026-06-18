# SPEC — Resource Layer + Staff Shifts

## 1. Mục tiêu
Cho AI Manager (và receptionist) biết đủ năng lực thật của tiệm:
- **Bao nhiêu giường/ghế/station** (resource layer)
- **Ai làm ngày nào, mấy giờ** (staff shifts)

## 2. Tính năng cốt lõi

### A — Resource Layer (hoàn thiện 50% còn lại)
- [x] Schema + GIST constraint (done)
- [x] CRUD + Settings UI owner (done)
- [x] RPC auto-assign bed (done)
- [x] Desk wiring walk-in + appointment (done)
- [ ] **Booking card/drawer hiển thị bed được assign** ("Bed 3")
- [ ] **Slot picker public booking** tính đúng capacity (khi tất cả bed bận → slot grey out)
- [ ] **Hi-Lite migration**: seed 7 beds + enable `resources_enabled`
- [ ] **Tests**: unit `checkResourceConflict()` + smoke test desk appoint

### B — Staff Shifts (mới hoàn toàn)
- [ ] Schema: `staff_shifts` (recurring weekly) + `staff_unavailability` (ngày nghỉ lẻ)
- [ ] Server actions: CRUD shifts + unavailability
- [ ] Admin UI: weekly grid (Mon–Sun × staff, set giờ từng ô, toggle ngày nghỉ)
- [ ] Availability integration:
  - `getAvailableTimeSlots()` → chỉ show slot trong giờ shift của staff đó
  - `availabilityEngine.ts` → filter staff không có ca hôm nay
- [ ] Backward-compat: salon không set shift = fallback toàn bộ giờ salon

### C — AI Manager context (nhỏ, kết nối sau khi A+B xong)
- [ ] Manager Briefing query thêm: tổng resources + shifts hôm nay → AI biết "7 beds, 3 staff"

## 3. Failure modes & mitigations

| Failure mode | Mitigation |
|---|---|
| Double-book cùng bed | GIST constraint + advisory lock trong RPC (đã có) |
| Booking cũ trước khi có shift | Shifts optional — NULL = salon hours (backward-compat) |
| Hi-Lite migration corrupt | Dry-run script trước, check count sau |
| Staff hết ca nhưng booking vẫn tạo được qua desk | Desk bypass intentional (receptionist override) |

## 4. Tech decisions
- `staff_shifts`: `UNIQUE(staff_id, day_of_week)` — 1 ca cố định / ngày / người
- `staff_unavailability`: `UNIQUE(staff_id, date)` — 1 ngày nghỉ / người
- Resource grid UI: không làm full "beds as columns" lần này — chỉ hiển thị bed name trên booking card (simpler, faster)
- Gating: `resources_enabled` per salon (12 tenant hiện tại off = unchanged)

## 5. Module breakdown & thứ tự build

| # | Module | Branch | ~Time |
|---|---|---|---|
| R1 | Booking card shows resource name | feat/resource-shifts | 1h |
| R2 | Public slot picker respects bed capacity | feat/resource-shifts | 2h |
| R3 | Hi-Lite migration + enable | feat/resource-shifts | 1h |
| R4 | Tests resource layer | feat/resource-shifts | 1h |
| S1 | Schema: staff_shifts + staff_unavailability | feat/resource-shifts | 1h |
| S2 | Server actions CRUD shifts | feat/resource-shifts | 2h |
| S3 | Admin UI: weekly shift grid | feat/resource-shifts | 3h |
| S4 | Availability integration | feat/resource-shifts | 2h |
| AI | AI Manager context update | feat/resource-shifts | 1h |

Total: ~14h → 1 ngày nếu parallel, 2 ngày nếu sequential

## 6. Không làm trong đợt này
- Full "beds as columns" trên timeline grid (phức tạp, để Phase 2)
- Shift swap / approval workflow
- Báo lỗi khi booking xung đột với ca làm (chỉ filter slot, không block desk)
