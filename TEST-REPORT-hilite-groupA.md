# 🧪 BÁO CÁO TEST — Nhóm A (Cá nhân) · Hi-Lite Head Spa

> Môi trường: `https://nailiq.ca/hilite-anaheim` · Verify: Receptionist Center (đã đăng nhập sẵn — Owner view)
> Ngày test: 05/06/2026 · Tất cả booking đặt cho **Thứ Hai 08/06/2026**
> Phạm vi đợt này: **A1–A10** (Nhóm Cá nhân). Nhóm B + Edge C sẽ chạy đợt sau.

---

## 📊 Tổng quan kết quả

| KB | Kết quả | Tóm tắt |
|----|---------|---------|
| A1 | ✅ Pass | Classic, không add-on. Done OK, không có bước chọn thợ, thợ tự gán = Anna |
| A2 | ✅ Pass | VVIP + 3 add-on cùng-lúc → **đúng 115′** (không tăng giờ), **$230** |
| A3 | ✅ Pass | Classic + Neck (làm-sau) → **80′** (65+15), **$105** |
| A4 | ✅ Pass* | Royal + 2 cùng-lúc + 2 làm-sau → **120′**, **$210** (cộng cả 4). *Lưu ý drawer #2 |
| A5 | ✅ Pass* | Sát giờ đóng: add-on không vừa **tự ẩn**. *Lưu ý #3, #4 |
| A6 | ✅ Pass | Chọn cả 7 add-on → **140′**, **$300**. Cùng-lúc + làm-sau đều chọn được khi còn giờ |
| A7 | ✅ Pass+ | Khách quen: nhận diện + tự điền tên + "Chào mừng trở lại" + đề xuất thợ quen Anna. **Vượt kỳ vọng** |
| **A8** | ❌ **FAIL** | **Oversell**: khung 7 giường nhận **8 booking** (xem #1) |
| A9 | ✅ Pass | SĐT sai → khoá nút; tên trống → khoá nút; email sai → báo lỗi rõ + chặn |
| A10 | ✅ Pass | Ghi chú "cho tôi thợ Anna" lưu được, lễ tân thấy ở GUEST NOTES |

**Tóm lại:** 9/10 Pass, 1 FAIL (A8 oversell). Có 4 finding phụ cần xem (1 console error chung, 3 minor UX/duration).

---

## 🔴 Lỗi cần sửa

### #1 — A8 OVERSELL (nghiêm trọng, chặn go-live)
**Triệu chứng:** Đặt 7 booking Classic cùng khung **4:00 PM** (tiệm chỉ có 7 giường/thợ). Sau booking thứ 7, khung 4:00 PM **vẫn hiển thị** trong lưới chọn giờ. Đặt tiếp khách thứ **8** → vẫn qua được bước "kiểm tra lịch đặt" và **xác nhận thành công** (gán cho Anna, mã `#NIQ-be8ffdcc`).

**Bằng chứng (Receptionist Center, 08/06):**
- Tổng booking ngày 08/06 đếm được = **16** (7 KB A1–A7 + 1 KB A10 + **8** bed-fill).
- Lưới Center khung 4:00 PM chỉ render **7 ô** (mỗi thợ 1: Bed Fill 1,3,4,5,6,7,8) — **Bed Fill 2 không hiển thị**.
- Đọc DOM lưới chỉ liệt kê 15/16 booking → 1 booking (Bed Fill 2) bị **double-book ẩn** trên 1 thợ ở 4:00 PM.
- Khung 4:00 PM **chỉ bị làm mờ/khoá SAU** khi đã có booking thứ 8 — tức ngưỡng chặn lệch 1 (cho phép N+1).

**Tác động:** 2 khách cùng 1 thợ/giường cùng giờ → khi tới tiệm sẽ kẹt, mất uy tín.

**Hướng nghi:** `conflictCheck.ts` là app-level (theo CLAUDE.md, không có DB constraint). Logic đếm capacity ở bước chọn giờ + bước xác nhận bị off-by-one (so sánh `<= 7` thay vì `< 7`, hoặc race khi nhiều booking gần nhau). Đề xuất thêm DB unique/exclusion constraint làm backstop.

---

## 🟡 Finding phụ (nên xem, không chặn go-live)

### #2 — A4: drawer Center lệch thời lượng
Drawer booking "Test A4 Royal Mix" hiện **SERVICE: Hi Lite Royal 105 minutes** và **SCHEDULE: 1:00 PM → 2:45 PM + 5 min buffer**.
Nhưng: màn khách báo **120 phút**, và ô lịch trong lưới hiện **1:00p–3:00p** (120′). → Drawer **thiếu ~15′** (có vẻ 1 trong 2 add-on làm-sau không cộng vào end-time của drawer). Lễ tân nhìn drawer sẽ tưởng ghế trống lúc 2:45 thay vì 3:00. Nên kiểm tra hàm tính duration cho booking có **nhiều add-on làm-sau**.
*(Đối chiếu A10 Classic thì khớp: service 60′ + 5 buffer = ô 2:00p–3:05p = đúng 65′ khách thấy.)*

### #3 — A5: LED Mask bị ẩn khi sát giờ đóng dù nhãn "+0′"
Khi chỉ còn **10 phút** đến giờ đóng (Classic 5:45 PM), hệ thống ẩn đúng **Neck/Shoulder (+15′)** (không vừa) ✓ và giữ **Scalp (+10′)** (vừa khít) ✓ — biên đúng. **Nhưng** cũng ẩn luôn **LED Light Therapy Mask** dù nhãn ghi **"✨ +0′"** (lẽ ra +0′ luôn vừa). → Có thể LED có thời lượng thật ẩn sau nhãn "+0′" (nhãn gây hiểu nhầm), hoặc bị lọc nhầm. Nên kiểm tra config thời lượng add-on LED.

### #4 — A5: ẩn hẳn thay vì "mờ/khoá"
Test plan mong add-on không vừa **"tự mờ/khoá"**. Thực tế app **ẩn hẳn** add-on khỏi danh sách. Vẫn chặn được lỗi, nhưng khác mô tả — nếu muốn đúng UX dự kiến thì để mờ + tooltip "không đủ giờ".

### #5 — Console error đỏ ở MỌI lần đặt (vi phạm verify điểm 4)
Mỗi lần xác nhận booking, console xuất 2 lỗi đỏ cấp app:
```
[submitPublicBooking] sms-confirm dispatch failed   TypeError: Failed to fetch
[submitPublicBooking] noshow-evaluate dispatch failed TypeError: Failed to fetch
```
Booking **vẫn thành công** — đây là 2 dispatch nền (SMS xác nhận + đánh giá no-show) gọi không tới (có thể edge-function/SMS chưa cấu hình ở môi trường test). Nên: (a) cấu hình endpoint cho prod, và (b) bọc try/catch + log mềm để không phun lỗi đỏ ra console khách.
*(4 lỗi "message channel closed" còn lại là của extension trình duyệt, không tính.)*

---

## ✅ Điểm tốt ghi nhận
- **Không có bước chọn thợ** trong luồng khách (đúng config) — hệ thống tự gán, xoay vòng đều cả 7 thợ: Anna → Bella → Chloe → Emma → Grace → Hannah → Ivy.
- **Tính giờ/tiền chính xác** cho mọi tổ hợp: cùng-lúc (+0′) không cộng giờ, làm-sau cộng đúng (+10′/+15′); tiền cộng đủ mọi add-on.
- **Badge "+N"** ở Center đúng tuyệt đối: A2 +3, A3 +1, A4 +4, A6 +7.
- **Drawer Center** hiện đủ add-on kèm nhãn **during** (cùng-lúc) / **after · +15m/+10m** (làm-sau) — đúng yêu cầu verify điểm 3.
- **Khách quen (A7)** là điểm WOW thực sự: nhận diện qua SĐT, tự điền tên, "Chào mừng trở lại · Lần thứ N", và đề xuất **đặt lại với thợ quen** (nhớ Anna từ lần trước).
- **Gợi ý giờ**: lưới giờ có badge "Gợi ý" để xếp lịch khít — UX cao cấp.
- **Màn "Xong"** luôn hiện đúng (mã booking + QR + tổng tiền + add-on), không quay về đầu; "Đặt lịch khác" reset form sạch (edge case C — OK).

---

## 📋 Bảng mã booking đã tạo (để Huy dọn)
| KB | Mã | Thợ | Gói | Giờ (08/06) | Tổng |
|----|-----|------|-----|------|------|
| A1 | #NIQ-1bce6280 | Anna | Classic | 10:00 | $85 |
| A2 | #NIQ-a5eae274 | Bella | VVIP +3 | 11:00 | $230 |
| A3 | #NIQ-36f6ffcd | Chloe | Classic +1 | 12:00 | $105 |
| A4 | #NIQ-c254e46c | Emma | Royal +4 | 13:00 | $210 |
| A5 | #NIQ-8812c91e | Grace | Classic | 17:45 | $85 |
| A6 | #NIQ-e6d02021 | Hannah | VVIP +7 | 09:00 | $300 |
| A7 | #NIQ-f4fdcabb | Anna | Classic (khách quen) | 11:30 | $85 |
| A8 | #NIQ-d8920a56 … #NIQ-a65e4568 (7 bed-fill) + **#NIQ-be8ffdcc** (overflow #8) | nhiều | Classic | 16:00 | $85 mỗi |
| A10 | #NIQ-600b44d2 | Ivy | Classic (note) | 14:00 | $85 |

> ⚠️ Tất cả là booking TEST trên `nailiq.ca/hilite-anaheim`. **Em KHÔNG tự xoá** — báo Huy dọn bằng 1 lệnh khi xong.

---

## ▶️ Đề xuất bước tiếp
1. Sửa **#1 (oversell A8)** trước go-live — đây là lỗi chặn.
2. Xem #2 (duration drawer) + #5 (console error) — ảnh hưởng vận hành/trải nghiệm.
3. Sau khi Huy duyệt báo cáo này → em chạy tiếp **Nhóm B (B1–B7)** và **Edge cases C**.
