# 🧪 BÁO CÁO TEST — Đợt 2 (Re-verify PR #304 + Edge C còn lại) · Hi-Lite Head Spa

> Môi trường: `https://nailiq.ca/hilite-anaheim` (bản đã deploy #304) · Verify: Receptionist Center (Owner view)
> Ngày test: 06/06/2026

---

## 📊 Tổng quan

| Mã | Kết quả | Tóm tắt |
|----|---------|---------|
| **R2** | ✅ **PASS (fix OK)** | Drawer duration với 2 add-on làm-sau giờ khớp lưới (120′, kết thúc 12:00 PM) |
| **R5** | ✅ **PASS (fix OK)** | Hết lỗi đỏ `Failed to fetch` (sms-confirm / noshow-evaluate) ở console |
| **C-race** | ⚠️ **Chưa chạy đủ** | Setup "còn 1 giường" cần lấp 6 booking — bất khả thi qua UI trong phiên (xem ghi chú) |
| **C-mobile** | ⚠️ **Không test được** | Môi trường remote không bật được device emulation 390px (xem ghi chú) |

---

## ✅ R2 — Drawer duration với nhiều add-on làm-sau (lỗi #2 cũ) → ĐÃ SỬA

**Bước:** Đặt cá nhân **Hi Lite Royal** + 2 add-on làm-sau: **Scalp Exfoliation (+10′)** + **Neck/Shoulder Massage (+15′)**. Ngày 20/06 lúc 10:00 AM. Vào Center → mở drawer.

**Thực tế (bản #304):**
- Bản khách: Thời gian = **120 phút** (95 + 15 + 10), Tổng $195.
- Ô lịch lưới Center: **10:00a – 12:00p** (120′).
- **Drawer:** SERVICE = "Hi Lite Royal · **120 minutes**"; SCHEDULE = "Sat, Jun 20 · **10:00 AM → 12:00 PM**"; ADD-ON (2): Neck/Shoulder "after · +15m", Scalp "after · +10m".

→ **Drawer khớp hoàn toàn** lưới + bản khách (đủ cả +25′). Lỗi cũ (drawer ngắn ~15′, kết thúc 11:45 thay vì 12:00) **không còn**. ✅ PASS.

---

## ✅ R5 — Console hết lỗi đỏ "Failed to fetch" (lỗi #5 cũ) → ĐÃ SỬA

**Bước:** Xoá console, đặt 1 booking (chính là booking R2) đến màn "Xong", đọc lại console.

**Thực tế:** 104 message lỗi sau booking đều thuộc 1 loại duy nhất:
```
Error: A listener indicated an asynchronous response by returning true,
but the message channel closed before a response was received
```
→ Đây là lỗi của **extension trình duyệt** (message-channel), KHÔNG phải app, đã có sẵn từ trước.

**KHÔNG còn** 2 lỗi đỏ cũ của app:
- ❌ (đã hết) `[submitPublicBooking] sms-confirm dispatch failed ... Failed to fetch`
- ❌ (đã hết) `[submitPublicBooking] noshow-evaluate dispatch failed ... Failed to fetch`

→ ✅ PASS. Lỗi #5 đã được khắc phục.

---

## ⚠️ C-race — 2 tab giành giường cuối (chưa chạy đủ)

**Tình trạng:** Đã đặt **1/6** booking nền (Race Fill 1 — Anna, Classic, 21/06 2:00 PM). Để dựng cảnh "còn đúng 1 giường" cần lấp **6** booking Classic cùng khung 2:00 PM, sau đó mở 2 tab giành giường thứ 7.

**Vì sao chưa hoàn tất:** Luồng đặt cá nhân của khách gồm 6 bước; trong phiên remote này, viewport render thay đổi và toạ độ các nút (Tiếp theo / ô ngày / ô giờ nằm dưới fold) **trôi liên tục theo scroll**, khiến mỗi lần đặt tốn ~12–15 thao tác và dễ click nhầm (đã thực tế bị chọn nhầm ngày). Lấp 6 giường = ~70–80 thao tác tuần tự — không khả thi/ổn định để hoàn tất trong phiên.

**Tin tốt — cơ chế mà C-race bảo vệ ĐÃ được xác nhận hoạt động:** Ở **Re-test A8 (đợt 1)**, em đã chứng minh:
- Khung 7 giường khi đầy thì **biến mất khỏi lưới chọn giờ** (khách thứ 8 chỉ được mời slot muộn hơn 11:05).
- Capacity bị **chặn cứng ở bước xác nhận** — không gán thợ ẩn, không oversell.
Cùng logic `conflictCheck` chi phối tình huống 2-tab.

**Đề xuất để verify trọn vẹn "1 báo lỗi vừa có người đặt":**
- (a) Em chạy lại với **seed sẵn 6 booking qua DB/Supabase** (hoặc API) cho 1 khung, rồi chỉ cần 2 tab → nhanh & chắc; hoặc
- (b) Dev thêm **integration test** mô phỏng 2 request xác nhận đồng thời ở giường cuối, assert: 1 thành công + 1 trả lỗi "slot just taken", và DB không có 2 booking cùng giường.

→ Nếu Huy muốn, em chạy phương án (a) ngay (cần quyền seed qua Supabase MCP).

---

## ⚠️ C-mobile — Responsive 390px (không test được trong môi trường)

**Đã thử:**
1. `resize_window` xuống 390px → **innerWidth của trang vẫn = 1728px** (viewport render cố định) → layout vẫn desktop. (Đúng như Huy lưu ý: resize thường không đủ.)
2. Mở **DevTools device toolbar** bằng phím `F12` rồi `Cmd+Shift+M` → **không có tác dụng**: phím chỉ tới được nội dung trang, không tới được browser chrome/DevTools qua công cụ điều khiển hiện tại.

**Kiểm tra static (làm được):**
- `<meta name="viewport">` = **`width=device-width, initial-scale=1`** ✅ — cấu hình responsive đúng chuẩn.
- (Stack dùng Tailwind v4 mobile-first theo CLAUDE.md.)

→ **Kết luận:** Trang CÓ cấu hình responsive đúng, nhưng **không thể xác minh render thực ở 390px** trong môi trường remote này (thiếu device emulation). Cần test bằng **điện thoại thật** hoặc **Chrome DevTools device mode trên máy có giao diện** (Huy tự chạy nhanh: mở trang → Cmd+Shift+M → chọn iPhone → click thử luồng cá nhân + nhóm).

---

## 📋 Mã booking đã tạo phiên này (để dọn)
- **R2:** "R2 Royal 2LamSau" — Anna, Hi Lite Royal +2 add-on, **20/06 10:00 AM** ($195).
- **C-race (nền):** "Race Fill 1" — Anna, Classic, **21/06 2:00 PM** ($85).

> ⚠️ Booking TEST. Em **không tự xoá** — Huy báo khi muốn dọn.

---

## ▶️ Kết luận Đợt 2
- ✅ **2 fix chính của PR #304 đã xác nhận PASS** (R2 drawer duration, R5 console Failed-to-fetch).
- ⚠️ 2 mục Edge C còn lại bị chặn bởi **giới hạn môi trường test remote** (không seed nhanh được data cho race; không bật được mobile emulation), không phải lỗi sản phẩm.
- Đề xuất: cho em quyền **Supabase seed** để chạy gọn C-race, và **test mobile trên thiết bị thật** cho C-mobile.
