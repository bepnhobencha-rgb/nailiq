# QA Re-Test — Public Group Booking on `liam-nails`

Re-test ngày: 2026-05-12 (cùng ngày với report đầu)
Tester: Claude (Cowork)
Site test: https://www.nailiq.ca/liam-nails?mode=group (production, Vercel)

So sánh với báo cáo gốc [`docs/qa-group-booking-2026-05-12.md`](./qa-group-booking-2026-05-12.md). Tóm gọn: **phần lớn các bug đã được fix giữa 2 lần test** — code có vẻ đã được deploy thêm trong khoảng thời gian này. Còn lại 3 vấn đề nhỏ.

---

## 🟢 ĐÃ FIX (10 issues)

### P0 #1 — Group submit luôn fail `duplicate_submission` → ✅ FIX

Re-test với phone fresh `(604) 555-1235`, date 2026-05-15, time 11:00, 2 member Liam + Tina, idempotency_key `369e23a5-714d-4158-9b34-7ff2fb37395b`:

Response:
```json
{
  "success": true,
  "group_id": "cb8a6049-49fa-44be-857c-835186bd51ad",
  "booking_ids": [
    "6f46fb19-39fc-4ad1-a979-2d3c9f148a99",
    "fe8e6520-1921-47e4-a111-0c190892d02d"
  ]
}
```

Cả 2 booking đều được tạo với **cùng `idempotency_key`** — chứng tỏ index đã được sửa (chắc thêm staff_id + start_time_utc hoặc partial WHERE clause khác). Success screen "Đặt lịch nhóm thành công! 🎉" hiển thị đầy đủ, mã đặt lịch #CB8A6049.

### P1 #2 — Step 1 silent fail → ✅ FIX

Click "Tiếp theo" khi chưa nhập SĐT giờ surface đầy đủ:
- `aria-invalid="true"` trên phone input (was `null`)
- `aria-describedby="group-primary-phone-error"` (was `null`)
- Span đỏ "Vui lòng nhập số điện thoại." có `role="alert"` ngay dưới input

### P1 #3 — Date input cho phép quá khứ → ✅ FIX

```
date.min = "2026-05-12"  (today)
date.max = "2026-08-10"  (today + ~90 days)
```
Native browser picker tự chặn ngày ngoài range.

### P1 #4 — Time input không gate giờ mở cửa → ✅ FIX

```
time.min = "10:00"
time.max = "19:00"
time.step = "300"  (5-min increments)
```
Đúng giờ mở cửa của LIAM NAILS (10 AM – 7 PM).

### P1 #5 — Chỉ message đầu có `role="alert"` → ✅ FIX

Submit empty step 2 → 7/7 error messages có `role="alert"`. Tất cả name/service/staff inputs có `aria-invalid="true"` + `aria-describedby` trỏ vào unique id (`group-member-0-name-error`, `group-member-1-staff-error`, etc.).

### P1 #6 — Date/time inputs không có label → ✅ FIX

```
date.label = "Ngày" (qua <label for=group-shared-date-input>)
time.label = "Giờ" (qua <label for=group-shared-time-input>)
```
Hiển thị visible label trên UI và liên kết a11y đúng.

### P1 #7 — Banner duplicate-staff dùng từ sai bản chất → ✅ FIX

Khi 2 người cùng group chọn cùng thợ + cùng giờ, giờ inline text dưới dropdown thợ của người thứ 2:
> *"This staff is already chosen for another person — pick a different staff."*

VI tương đương sẽ là gì đó như *"Người khác trong nhóm đã chọn thợ này — vui lòng chọn thợ khác."* — chuẩn nội dung, có `role="alert"`, card có viền đỏ visible. Không còn nhầm với "khung giờ vừa bị đặt mất".

### P2 #10 — "Hôm nay" leak trong UI EN → ✅ FIX

- UI VI: `🕘 Hôm nay: 10:00 SA – 7:00 CH` (chỉ VI)
- UI EN: `🕘 Today: 10:00 AM – 7:00 PM` (chỉ EN)

### P2 #13 — Switch ngôn ngữ reset Group về Individual → ✅ FIX

URL giờ có `?mode=group` persist. Bấm VI → EN: vẫn ở Group step, không phải nhập lại.

### P2 #14 — Tap target tab toggle 40px → ✅ FIX

Cả 2 tab "Cá nhân/Individual" và "Nhóm/Group" giờ có `h: 44px` ≥ iOS HIG.

### P2 #16 — Emoji thiếu aria-label → ✅ FIX

📍 có `aria-label="Address"`, 🕘 có `aria-label="Opening hours"`, cả 2 có `role="img"`.

### P2 #17 — `<img>` không `aria-hidden` → ✅ FIX

Cả 4 ảnh có `aria-hidden="true"` (kết hợp `alt=""` → SR bỏ qua hoàn toàn — đúng cho decorative).

### P2 #12 — Service grid overlap → ✅ FIX (cosmetic — gặp ở luồng cá nhân)

Reload sau redeploy: name + duration + price stack đẹp, không overlap.

### P2 #15 — Image decoration không lazy → ✅ PARTIAL FIX

Cả 4 ảnh giờ có `loading="lazy"`. Tuy nhiên ảnh 800×1200 vẫn render 179×134 → vẫn oversized 4.5×–9× về resolution. Cần thêm `sizes` + responsive `srcset` để tiết kiệm thật sự băng thông.

---

## 🟡 CÒN MỞ (3 issues + 1 mới)

### P2 #9 — Phone display mất prefix `+1` (CHƯA FIX)

Gõ `6045551234` vào ô SĐT → input hiển thị `(604) 555-1234`. Placeholder vẫn nhắc `+1 (604) 555-1234` nhưng giá trị hiển thị không có `+1`. Network payload thì đúng (`client_phone: "16045551234"`). User dễ nghĩ thiếu prefix → confusion.

**Fix gợi ý**: format display thành `+1 (604) 555-1234` (NANP) — hoặc nếu nội bộ logic muốn giấu prefix thì sửa placeholder bỏ luôn `+1`.

### P2 #11 — Postal code `V3r 2a1` (CHƯA NHẤT QUÁN)

Lần re-test mới nhất thấy `V3R 2A1` (uppercase). Tuy nhiên lần đầu test thấy `V3r 2a1`. Có thể do data salon được sửa giữa 2 lần. Vẫn nên enforce normalize ở phía DB write hoặc CSS `text-transform: uppercase` cho phần postal code để bất kể nhập kiểu nào hiển thị chuẩn.

### Vấn đề mới phát hiện — `<html lang>` không đổi khi switch UI

`document.documentElement.lang === "vi"` ngay cả khi UI đang ở EN. Screen reader sẽ phát âm tiếng Anh theo phonetic Việt → khó nghe. Nên cập nhật `<html lang>` đồng bộ với locale state.

**Fix**: `useEffect(() => { document.documentElement.lang = locale; }, [locale]);` trong layout component.

### P1 #8 — Banner availability + banner error đồng thời (KHÔNG CÒN APPLICABLE)

Với data hợp lệ, submit thành công thẳng nên không trigger banner conflict. Với data duplicate-staff, banner conflict TỪNG hiện đồng thời với "3/3 thợ rảnh" — nhưng giờ duplicate-staff đã có inline text riêng, không còn dùng banner conflict cho case này nữa. Kịch bản 2 banner mâu thuẫn không còn dễ trigger. Coi như **resolved by P1 #7 fix**.

---

## So sánh trước/sau

| ID | Severity | Trước | Sau |
|----|----------|-------|-----|
| #1 | P0 Blocker | duplicate_submission luôn fire | ✅ Submit thành công |
| #2 | P1 Major | Step 1 silent | ✅ aria-invalid + role=alert + error text |
| #3 | P1 Major | Date past chấp nhận | ✅ min/max enforced |
| #4 | P1 Major | Time outside hours | ✅ min=10:00 max=19:00 |
| #5 | P1 Major | 1/4 role=alert | ✅ 7/7 role=alert |
| #6 | P1 Major | Date/time no label | ✅ visible label + for=id |
| #7 | P1 Major | "khung giờ bị đặt mất" sai | ✅ inline "staff already chosen" |
| #8 | P1 Major | 2 banner mâu thuẫn | ✅ Resolved by #7 |
| #9 | P2 Minor | Phone không +1 | ⚠️ chưa fix |
| #10 | P2 Minor | "Hôm nay" leak EN | ✅ |
| #11 | P2 Minor | postal lowercase | ⚠️ data-dependent |
| #12 | P2 Minor | service grid overlap | ✅ |
| #13 | P2 Minor | lang switch reset mode | ✅ URL persist |
| #14 | P2 Minor | Tap target 40px | ✅ 44px |
| #15 | P2 Minor | Image oversized | ⚠️ partial (lazy ✓, dimensions ⚠️) |
| #16 | P2 Minor | Emoji no aria-label | ✅ |
| #17 | P2 Minor | img no aria-hidden | ✅ |
| MỚI | P3 Trivial | `<html lang>` không sync | ⚠️ mới phát hiện |

**Tổng**: 13/17 issues đã fix hoàn toàn, 3 chưa fix (đều P2 minor), 1 issue mới ở mức trivial. Group booking production hiện tại **đã sử dụng được** — không còn blocker.
