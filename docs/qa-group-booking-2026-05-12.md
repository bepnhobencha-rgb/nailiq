# QA Report — Public Group Booking on `liam-nails`

Test ngày: 2026-05-12
Tester: Claude (Cowork)
Site test: https://www.nailiq.ca/liam-nails (production, Vercel)
Salon: LIAM NAILS, Surrey BC, 3 thợ active (cap nhóm = 3)
Phạm vi: Bật toggle Nhóm → chạy đủ 3 bước (size → members → success), test VI + EN, desktop 1280px và mobile 390px.

---

## 🚨 P0 — Blocker (chặn release)

### 1. Group booking KHÔNG THỂ thành công ở production — `duplicate_submission` mỗi lần submit

**Triệu chứng**: bất kỳ submit nhóm hợp lệ nào (đủ field, ngày tương lai, mỗi người 1 thợ khác nhau, idempotency_key fresh) đều fail với banner:
> *"Có vẻ nhóm này đã được đặt rồi. Tải lại trang để xem xác nhận."*

**Root cause** (file: `supabase/migrations/20260512200000_group_booking.sql:31-33`):
```sql
CREATE UNIQUE INDEX idx_bookings_idempotency
  ON public.bookings (salon_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```
Index UNIQUE trên `(salon_id, idempotency_key)`. Mặt khác client (`src/shared/booking/submitGroupBooking.ts:335-355`) stamp **cùng một `idempotency_key`** lên TẤT CẢ N member trong group:
```ts
const idem = params.idempotencyKey;
const payload = resolved.map((r) => ({ ..., idempotency_key: idem }));
```
RPC `insert_group_bookings` insert lần lượt từng row trong FOREACH loop. Row 1 thành công. Row 2 dùng cùng `(salon_id, idempotency_key)` → vi phạm UNIQUE → `WHEN unique_violation THEN ... code: 'duplicate_submission'` → toàn bộ transaction rollback (savepoint của BEGIN block) → client thấy duplicate_submission, không có booking nào được tạo.

**Bằng chứng**:
- Network request fresh UUID `f8fc9621-01c2-45d5-b1ca-e6f5d8642a77` → response `{"code":"duplicate_submission","success":false}`
- Query `bookings` với phone test → trả `[]` (không có row → confirm rollback chạy đúng)
- Migration mới nhất `20260512300000_group_booking_size_up_to_8.sql` chỉ nâng cap 4→8, KHÔNG sửa index

**Cách fix** (1 trong 4):
1. Đổi UNIQUE thành `(salon_id, idempotency_key, staff_id, start_time_utc)` — vẫn chống re-submit nhưng cho phép nhiều row cùng idem.
2. Đổi UNIQUE thành `(salon_id, idempotency_key)` `WHERE group_size IS NULL` — chỉ enforce cho cá nhân.
3. Client sinh N UUID khác nhau cho N member, idempotency check tách qua bảng riêng `booking_group_idempotency(salon_id, key)` UNIQUE.
4. Trước FOREACH, function check `IF EXISTS(SELECT 1 FROM bookings WHERE salon_id=... AND idempotency_key=...)` thay vì dựa vào index violation. Thêm UNIQUE qua bảng phụ.

**Khuyến nghị**: option (1) — ít thay đổi nhất, vẫn chống double-click vì cùng phối hợp `(idem, staff, start_time)` không thể có 2 row dù gọi lại.

---

## 🔴 P1 — Major (logic + a11y nghiêm trọng)

### 2. Step 1 (size + phone) — submit fail silent, không có error message
File: `BookingGroupFlow.tsx` (step "size")

- Click "Tiếp theo" khi chưa nhập SĐT: nút **không** disabled (`disabled: false`, `opacity: 1`), không proceed, chỉ đổi border của phone input sang đỏ alpha 0.5 (`lab(55.7853 65.6165 40.7976 / 0.5)`).
- Phone input KHÔNG có `aria-invalid`, KHÔNG có `aria-describedby`, KHÔNG có `[role="alert"]`/`[aria-live]` element kèm text giải thích.
- Sighted user thấy click không tác dụng. SR user không biết có lỗi.

**Fix**: thêm error text bên dưới input ("Vui lòng nhập số điện thoại"), set `aria-invalid="true"`, `aria-describedby` trỏ vào error span có `role="alert"`. Hoặc disable nút nếu không hợp lệ (matches step 2 hiện đang validate đầy đủ).

### 3. Date input cho phép ngày trong quá khứ
- Input `<input type="date">` ở step 2 không có thuộc tính `min` (đo qua DOM: `min: ""`).
- Test 2026-05-11 (hôm qua, hôm nay 2026-05-12) → client chấp nhận, gửi lên server. Server xử lý theo conflict check thường, không có rule riêng cho past date.
- Người dùng nhập sai → nhận error mơ hồ ("khung giờ vừa bị đặt mất").

**Fix**: set `min={hôm nay theo timezone salon}`, optional `max={now+90d}`. Đồng thời server reject past date với `code: 'invalid_input'` rõ ràng.

### 4. Time input không gate theo giờ mở cửa
- `<input type="time">` không có `min`/`max`. User có thể nhập 03:00 AM (salon đóng).
- Salon hours là 10:00–19:00 nhưng UI không hạn chế.
- Sẽ fail ở server với error không rõ nguyên nhân.

**Fix**: dùng visual time picker đã có ở luồng cá nhân (đã lưu ý là deferred trong PR #142), hoặc tối thiểu set `min`/`max` dựa trên opening hours của salon cho ngày được chọn.

### 5. Lỗi inline trên member field KHÔNG có `role="alert"`
- Chỉ message schedule ("Vui lòng chọn ngày và giờ cho cả nhóm.") có `role="alert"`.
- 3 message còn lại ("Vui lòng nhập họ tên.", "Vui lòng chọn dịch vụ để tiếp tục.", "Vui lòng chọn thợ.") không có role, không có aria-live.
- SR sẽ chỉ đọc 1 lỗi đầu, bỏ qua N lỗi sau.

**Fix**: bọc cụm errors trong một `<div role="region" aria-live="polite">` hoặc add `role="alert"` cho từng span. Đồng thời `aria-invalid="true"` trên input/select tương ứng + `aria-describedby` link với span lỗi.

### 6. Date + time input không có `<label>` liên kết
- Page accessibility tree gọi date/time inputs là `(no name)`.
- Heading "Ngày & giờ chung của nhóm" chỉ là `<p>`, không có `aria-labelledby` liên kết.

**Fix**: bọc trong `<label>Ngày<input type="date">...` hoặc thêm `aria-label`/`aria-labelledby`.

### 7. Banner conflict dùng từ ngữ MISLEADING khi nguyên nhân là duplicate staff
- Khi cross-member conflict (2 người trong group chọn cùng thợ + cùng giờ), banner hiển thị: *"Có N khung giờ vừa bị đặt mất. Điều chỉnh lại và thử lại."*
- Bản chất KHÔNG phải "ai đó vừa đặt mất" — đây là conflict do user tự tạo trong cùng form.
- Hiện tại UI có flag visual (viền đỏ trên card Người 2) nhưng không có text giải thích kế bên dropdown thợ.

**Fix**: tách 2 trường hợp trong `groupCopy`:
  - `cross_member_staff_conflict`: "Hai người không thể chọn cùng một thợ. Vui lòng chọn thợ khác cho Người N."
  - `external_slot_taken` (giữ message cũ): "Khung giờ vừa bị đặt mất bởi khách khác. Vui lòng chọn giờ khác."

Server cần trả thêm field `conflict_kind: 'cross_member' | 'external'` trong response.

### 8. Banner availability mâu thuẫn banner error
- Sau khi date/time được điền, banner xanh nhỏ: *"Có 3/3 thợ rảnh vào giờ này."*
- Submit fail → banner đỏ ở trên cùng: *"Có 1 khung giờ vừa bị đặt mất."*
- 2 banner đồng thời hiển thị → người dùng confused.

**Fix**: sau khi submit fail, ẩn availability banner hoặc tự refresh availability check ngay sau error.

---

## 🟠 P2 — Minor (cosmetic / UX nhẹ)

### 9. Phone format mất prefix `+1` sau khi nhập
- Placeholder: `+1 (604) 555-1234`
- Sau khi gõ `6045551234` → input hiển thị `(604) 555-1234` (mất `+1`).
- Network payload đúng (`client_phone: "16045551234"`) nhưng display gây nhầm lẫn — user nghĩ thiếu prefix.

**Fix**: format display thành `+1 (604) 555-1234` cho đồng nhất với placeholder.

### 10. i18n leak — "Hôm nay" tiếng Việt trong UI tiếng Anh
- Hero card dòng giờ: `🕘 **Hôm nay** · Today: 10:00 AM – 7:00 PM`
- Cả khi UI đang ở chế độ EN, từ "Hôm nay" vẫn xuất hiện cứng.
- Có thể intentional bilingual? Nếu vậy thì ở VI cũng đang trùng nghĩa ("Hôm nay" và "Today" cùng dòng).

**Fix**: chọn 1 ngôn ngữ theo `t.lang` thay vì in cả 2. Hoặc remove "Today:" prefix nếu intentional VI-only.

### 11. Capitalization địa chỉ
- Hero: `15775 85 ave, Surrey, BC V3r 2a1, Canada`
- Canadian postal code đúng phải là `V3R 2A1` (uppercase). Street type `ave` phải là `Ave`.
- Là data từ DB của salon, nên fix ở data hoặc thêm CSS `text-transform` cho postal code + smart-case cho street.

### 12. Service grid bị OVERLAP (cả VI và EN) — luồng cá nhân
- Service card hiển thị name + duration + price chồng đè lên nhau:
  - "Chrome Powder Nails" + "85 phút" + "$60.00" overlap
  - "Classic Manicure" + "POPULAR" badge overlap
  - "Nail Art (per nail)" + "35 min" + "$5.00" overlap (EN tệ hơn vì tên dài)
- **Không phải bug group nhưng ảnh hưởng UX chính của booking** — nên cần đề cập.

**Fix**: tăng padding cell, set `min-height` cố định cho card, hoặc đặt giá + duration ở dòng riêng dưới name (stack thay vì side-by-side).

### 13. Switch ngôn ngữ reset booking type về Individual
- Đang ở Group → bấm EN → trang reload và rơi về Individual mặc định.
- Người dùng phải bấm lại Group + nhập lại data đã điền.

**Fix**: persist `mode` ở `BookingTypeSwitcher` qua URL query (`?mode=group`) hoặc sessionStorage để rerender sau locale switch giữ nguyên.

### 14. Tap target heading toggle dưới 44px (40px)
- `[data-testid="booking-type-individual"]` h=40px (`min-h-10` trong code).
- iOS HIG khuyến nghị ≥ 44×44 cho touch target.
- Width thì rộng (219px) nên ít rủi ro mis-tap, nhưng vẫn dưới chuẩn.

**Fix**: bump lên `min-h-11` (44px) hoặc tăng `py-2.5`.

### 15. Image decoration oversized
- Hai ảnh decoration thumbnail 800×1200 và 800×534 hiển thị ở 179×134 → tỷ lệ 4.5×9× lớn hơn cần thiết → lãng phí băng thông trên 3G (Vietnam market).
- Ảnh không có `loading="lazy"`.

**Fix**: serve responsive images qua `<Image>` của Next.js (`sizes`, `srcset`), thêm `loading="lazy"` cho ảnh decoration.

### 16. Emojis 📍 🕘 không có aria-label / role="img"
- Screen reader đọc tên gọi mặc định (vd "round pushpin", "shortcake") không có ngữ cảnh.

**Fix**: bọc bằng `<span role="img" aria-label="Địa chỉ">📍</span>` và `aria-label="Giờ mở cửa">🕘</span>`. Hoặc thay bằng SVG icon.

### 17. Tất cả `<img>` đều `alt=""` nhưng không có `aria-hidden="true"`
- Empty alt → SR vẫn announce "image" cho 4 ảnh.
- Cần thêm `aria-hidden="true"` nếu thật sự decorative.

---

## ✅ Những điều làm TỐT

- Contrast WCAG AA pass cho cả heading uppercase 12px (5.34:1), helper text (5.34:1), text trắng full (19.55:1).
- Step 1 → 2 → success state machine rõ.
- Sticky primary contact summary với link "Sửa" (P1.G1 fix) ✓
- Sticky bottom total bar "Tổng: 2 người · 40 phút · $50.00" giúp người dùng nắm chi phí ngay.
- Pill size 44px height ✓ tap target.
- Validate empty submit step 2 hiển thị 4 message inline cụ thể, scroll vào lỗi đầu tiên.
- Solo-staff salon thì toggle "Nhóm" ẩn hoàn toàn (đúng logic `groupEnabled`).
- Group cap = `Math.min(activeStaff, 6)` enforced cả client + server.
- Real-time availability check ("Có 3/3 thợ rảnh vào giờ này.") chạy sau debounce 400ms, không thrash RPC.
- Brand color (gold #D4AF37) áp dụng nhất quán cho active states.
- Mobile 390px layout không vỡ — Continue button full-width, single column.

---

## Đề xuất ưu tiên fix
1. **P0 #1** — block release. Sửa migration index hoặc đổi client gen multi-key.
2. **P1 #2, #5, #6** — block QA pass về a11y. Fix song song với P0.
3. **P1 #3, #4, #7, #8** — Sửa trong cùng PR follow-up để giảm tỉ lệ user nhận lỗi mơ hồ.
4. **P2 #9–#17** — Backlog grooming, gộp với epic UI polish.

## Cách tái lập P0
```
1. https://www.nailiq.ca/liam-nails
2. Click "Nhóm 👥"
3. Size 2, phone 6045551234, Tiếp theo
4. Date: tomorrow, Time: 15:30
5. Người 1: Test A + Classic Manicure + Liam (Owner)
6. Người 2: Test B + Classic Manicure + Tina
7. Click "Xác nhận đặt lịch nhóm"
→ banner: "Có vẻ nhóm này đã được đặt rồi..."
→ network: POST /rpc/insert_group_bookings response {"code":"duplicate_submission","success":false}
→ DB query: SELECT * FROM bookings WHERE client_phone='16045551234' → 0 rows
```
