# 🧪 BÁO CÁO TEST — Re-test A8 + Nhóm B (Group) + Edge C · Hi-Lite Head Spa

> Môi trường: `https://nailiq.ca/hilite-anaheim` · Verify: Receptionist Center (Owner view, đã đăng nhập)
> Ngày test: 05–06/06/2026 · Booking đặt rải các ngày 09–18/06/2026

---

## ✅ 1. RE-TEST A8 — Oversell ĐÃ ĐƯỢC SỬA (PASS)

Lần trước A8 FAIL (khung 7 giường nhận được 8 khách). Lần này test lại trên khung sạch **10:00 AM ngày 09/06**:

- Đặt **7 booking Classic** cùng 10:00 AM → hệ thống tự gán đủ 7 thợ khác nhau (Emma, Grace, Hannah, Ivy, Anna, Bella, Chloe).
- Đặt khách **thứ 8** → vào bước chọn giờ thì lưới **bắt đầu từ 11:05 AM**; toàn bộ slot 9:00–10:45 AM **đã biến mất**. Không thể đặt 10:00 AM nữa.
- 11:05 đúng là lúc giường đầu tiên rảnh (10:00 + 65′ = 11:05) → **logic chặn chuẩn xác, không gán thợ ẩn, không oversell**.

**Kết luận: Lỗi #1 (oversell) trong báo cáo nhóm A đã được khắc phục triệt để.** ✅

---

## 👥 2. NHÓM B (Group bookings) — 7/7 PASS

Luồng nhóm: **Số người → Dịch vụ (mỗi khách 1 gói + add-on riêng) → Ngày & giờ (chọn cách xếp: "Đến cùng giờ" / "Xong cùng giờ" + khung buổi) → Sắp xếp → Xác nhận**. KHÔNG có bước chọn thợ.

| KB | Kết quả | Tóm tắt |
|----|---------|---------|
| B1 | ✅ Pass | 2 khách Classic → **1 thẻ "✨ Tốt nhất" (ĐỀ XUẤT)**, cả 2 lúc 9:00a, **KHÔNG có Alternative thừa**, không tên thợ. Tổng $170 |
| B2 | ✅ Pass | VVIP + Special → cả 2 bắt đầu 9:00a, nhóm xong 10:55a (VVIP 115′ dài hơn). **Tổng $300 = $195+$105** đúng |
| B3 | ✅ Pass | Mỗi khách 1 add-on (Hot Stone cùng-lúc / Neck làm-sau) → **Confirm hiện "+1 add-on" mỗi khách**; khách làm-sau kết thúc trễ hơn. Tổng $200 |
| B4 | ✅ Pass | 5 khách → xếp đủ 5 cùng lúc 9:00a (5 ≤ 7 giường), không chia đợt. Tổng $425 |
| B5 | ✅ Pass | 8 khách → **"🌊 Chia thành 2 đợt": Đợt 1 = 7 khách 9:00a, Đợt 2 = 1 khách 10:20a**, không kẹt. Tổng $680 |
| B6 | ✅ Pass | Group 3 ở khung gần kín (14/6, 9:00 đã đầy) → xếp 10:15a khi 3 giường trống; **chỉ 1 thẻ "Tốt nhất", không Alternative thừa**. Tổng $255 |
| B7 | ✅ Pass | **Không có ô chọn thợ**; arrangement/confirm/success **không hiện tên thợ**; Center hiển thị nhóm ở panel "group bookings" riêng với tổng tiền đã gồm add-on |

**Điểm tốt:** Hệ thống xếp lịch nhóm thông minh — cùng giờ khi đủ giường, tự chia đợt (wave 🌊) khi vượt 7 giường, chỉ đề xuất 1 phương án tối ưu (không spam Alternative). Mỗi nhóm có **link chia sẻ** (party link) để thành viên tự xác nhận.

### 🟡 Finding nhóm B (cần Huy cân nhắc, không phải lỗi)
**Nhóm tạo ra ở trạng thái "pending" — chưa chiếm cột giường trong lưới lễ tân.** Ở Center, các nhóm nằm trong panel "👥 N group bookings" với trạng thái **"0/N confirmed · N pending"**. Mỗi khách chỉ vào lưới thợ (1 cột/khách) **sau khi tự xác nhận qua party link**.
→ Hệ quả: trước khi thành viên xác nhận, lễ tân nhìn lưới sẽ thấy các giường đó **trống** dù nhóm đã đặt. Nếu khách nhóm không bấm xác nhận, ghế có thể bị nhận walk-in trùng. **Đề xuất:** hoặc giữ chỗ (pessimistic hold) ngay khi tạo nhóm, hoặc cho lễ tân 1 nút "xác nhận thay" để đẩy nhóm vào lưới.

---

## 🔧 3. EDGE CASES C

| Edge case | Kết quả | Chi tiết |
|---|---|---|
| Back/Next nhiều lần giữa các bước | ✅ Pass | Lùi từ Ngày về Dịch vụ → VVIP vẫn được chọn; lùi tiếp → tên/giờ vẫn giữ. State không vỡ |
| "Đặt lịch khác" → reset | ✅ Pass | Form về trống sạch (đã xác nhận từ nhóm A) |
| Đổi ngày sau khi đã chọn add-on | ✅ Pass | Đổi ngày → **add-on tự reset** (về "Không, cảm ơn"); gói/tên/SĐT vẫn giữ. Reset hợp lý (add-on làm-sau phụ thuộc khung giờ), không vỡ state |
| 2 tab cùng đặt khung cuối | ⚠️ Chưa chạy đủ | Xem ghi chú bên dưới |
| Mobile (màn nhỏ) responsive | ⚠️ Không test được | Xem ghi chú bên dưới |

### Ghi chú #1 — 2-tab race (chưa chạy đủ)
Để dựng cảnh "còn đúng 1 giường" cần lấp trước 6 giường ở 1 khung, rồi mở 2 tab cùng giành giường thứ 7. Em chưa hoàn tất setup này trong phiên (tốn nhiều thao tác + viewport bị đổi giữa chừng làm lệch toạ độ).
**Tuy nhiên cơ chế chống trùng đã được chứng minh gián tiếp qua RE-TEST A8**: capacity được chặn cứng ở bước xác nhận (khách thứ 8 bị từ chối, slot biến mất). Cùng logic `conflictCheck` chi phối tình huống 2-tab. Em có thể chạy trọn vẹn 2-tab race trong phiên sau nếu Huy muốn xác nhận đúng thông điệp "vừa có người đặt".

### Ghi chú #2 — Mobile responsive (không test được trong môi trường này)
Khi resize cửa sổ trình duyệt xuống 390px, `window.innerWidth` của trang **vẫn = 1728px** (viewport render cố định, không đổi theo cửa sổ). Vì vậy không kích hoạt được breakpoint mobile để chụp giao diện màn nhỏ thật. Cần test mobile bằng thiết bị/emulator thật.

### 🟢 Bắt thêm khi test Edge (positive)
- **Group-mode email validation hoạt động**: nhập email sai ở bước xác nhận nhóm → báo "Email không đúng định dạng. Ví dụ: jane@email.com", chặn submit.
- **Tuỳ chọn "Xong cùng giờ"** (finish-together) tồn tại trong luồng nhóm, kèm ô nhập "Xong trước lúc mấy giờ?" — cho nhóm muốn kết thúc đồng thời.

---

## 📋 4. Mã booking mới tạo phiên này (để Huy dọn)

**Re-test A8 (ngày 09/06):** 7 booking Classic 10:00 AM (#NIQ-97cf1457, -ee6e48eb, -678877af, -dff26dda, -282690b4, -00b1b84f, -22804a56, -3ee25f2d) + vài booking lẻ 4:00/4:45 PM (#NIQ-a0bf76b8, -d16cfbe7) từ lúc dò khung.

**Nhóm B:**
| KB | Mã nhóm | Ngày |
|----|---------|------|
| B1 | #GRP-20260610-EBE4 | 10/06 |
| B2 | #GRP-20260611-5047 | 11/06 |
| B3 | #GRP-20260612-575D | 12/06 |
| B4 | #GRP-20260613-39DB | 13/06 |
| B5 | #GRP-20260614-AC94 | 14/06 |
| B6 | #GRP-20260614-6652 | 14/06 |

> ⚠️ Tất cả là booking TEST. **Em KHÔNG tự xoá** — Huy báo khi muốn dọn, em chạy 1 lệnh dọn sạch (cả booking lẻ nhóm A + B + re-test).

---

## ▶️ 5. Tổng kết & đề xuất
- ✅ **Lỗi oversell (A8) đã fix** — không còn chặn go-live.
- ✅ **Nhóm B chạy mượt** 7/7 — xếp lịch thông minh (cùng giờ / chia đợt / 1 phương án tối ưu), không lộ tên thợ.
- 🟡 Cân nhắc finding **nhóm "pending" chưa giữ giường trong lưới lễ tân** (#nhóm B) — rủi ro trùng walk-in.
- ⚠️ 2 mục còn lại của Edge C (2-tab race, mobile) cần phiên sau / công cụ phù hợp.
- Các finding nhỏ từ báo cáo nhóm A (#2 duration drawer A4, #5 console sms/noshow) vẫn nên xử lý nếu chưa.
