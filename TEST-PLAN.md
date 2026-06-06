# 🧪 TEST PLAN — Đặt lịch Hi-Lite Head Spa (NailIQ)

> Yêu cầu test toàn diện luồng **đặt lịch cá nhân + nhóm** của tenant **Hi-Lite Head Spa**,
> tìm mọi lỗi trước khi go-live. Giao cho Cowork Claude (hoặc tester) thực hiện.

## Bối cảnh
- **URL đặt lịch (TEST, không phải web thật):** https://nailiq.ca/hilite-anaheim
- Môi trường test — tạo booking thoải mái, sẽ dọn sau.
- **Verify ở Receptionist Center:** https://nailiq.ca/dashboard/hilite-anaheim/center
  (cần đăng nhập — xin Huy cấp tài khoản owner/lễ tân).

## Cấu hình tiệm (để biết kết quả ĐÚNG là gì)
- **Giờ mở:** 9:00–19:00. **7 giường/thợ:** Anna, Bella, Chloe, Emma, Grace, Hannah, Ivy. Buffer 5 phút.
- **KHÔNG cho khách chọn thợ** → luồng KHÔNG có bước chọn thợ; hệ thống tự gán thợ.
- **5 gói chính** (thời lượng phút): Classic $85 (65) · Special $105 (75) · Deluxe $125 (85) ·
  Royal $155 (95, "Phổ biến") · VVIP $195 (115, "Nổi bật").
- **7 add-on:**
  - *Cùng lúc (+0 phút):* Collagen Eye Mask $5 · Hot Stone $10 · Premium Product Upgrade $10 · Hot Oil $20 · LED Light Therapy Mask $20
  - *Làm sau (+giờ):* Scalp Exfoliation $20 (+10′) · Neck/Shoulder Massage $20 (+15′)

## Mỗi lịch đặt xong PHẢI verify 4 điểm
1. **Màn "Xong"** hiện (confetti + mã booking + danh sách add-on + tổng tiền) — KHÔNG được quay về đầu.
2. **Tổng giờ + tổng tiền đúng** (gói + add-on; add-on "cùng lúc" KHÔNG cộng giờ).
3. **Receptionist Center:** booking hiện đúng giờ/thợ; ô lịch có badge **"+N"** nếu có add-on;
   mở drawer thấy đủ add-on + nhãn "cùng lúc / làm sau".
4. **Console (F12)** không có lỗi đỏ.

---

## A. KỊCH BẢN CÁ NHÂN (Individual)
| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| A1 | Đặt 1 gói (Classic), không add-on | Done OK; không có bước chọn thợ; lễ tân thấy 1 cột thợ tự gán |
| A2 | VVIP + 3 add-on **cùng lúc** (Eye Mask + Hot Stone + LED) | Tổng giờ = **đúng 115′** (không tăng); tổng tiền = $195+$5+$10+$20 = $230 |
| A3 | Classic + 1 add-on **làm sau** (Neck Massage +15′) | Giờ kết thúc lùi thêm 15′; drawer hiện "làm sau · +15′" |
| A4 | Gói + mix (2 cùng-lúc + 2 làm-sau) | Chỉ 2 cái làm-sau cộng giờ; tổng tiền cộng cả 4 |
| A5 | Đặt **sát giờ đóng cửa** (gần 19:00) rồi thử thêm add-on làm-sau | Add-on không vừa khung phải **tự mờ/khoá** |
| A6 | Chọn **tất cả 7 add-on** | Cùng-lúc luôn chọn được; làm-sau chỉ chọn khi còn giờ |
| A7 | **Khách quen**: đặt 1 lần rồi đặt lại bằng **cùng SĐT** | Bước SĐT nhận diện khách cũ + đề xuất "đặt lại như lần trước" |
| A8 | Lấp đầy **7 giường** cùng 1 khung rồi đặt khách thứ 8 | Khung đó **biến mất** (hết giường), gợi ý giờ khác |
| A9 | Nhập **SĐT/email/tên sai định dạng** | Báo lỗi rõ, không cho submit |
| A10 | Ghi ô "Lời nhắn": "cho tôi thợ Anna" | Lưu được; lễ tân thấy ghi chú |

## B. KỊCH BẢN NHÓM (Group)
| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| B1 | 2 khách, **cùng gói** Classic | Arrangement chỉ **1 thẻ "Best"** (cùng giờ), **KHÔNG có "Alternative" thừa**; KHÔNG hiện tên thợ |
| B2 | 2 khách, **gói khác nhau** (VVIP + Special) | Xếp lịch hợp lý; tổng tiền = tổng 2 gói |
| B3 | 2 khách, **mỗi khách add-on riêng** (1 cùng-lúc, 1 làm-sau) | Khách có add-on làm-sau bị lùi giờ; Confirm hiện **"+N add-on"** mỗi khách |
| B4 | Nhóm **5 khách** | Arrangement xếp đủ 5 (≤ 7 giường) |
| B5 | Nhóm **8 khách** (> 7 giường) | Tự chia **"wave/đợt"** (🌊), không kẹt |
| B6 | Group ở khung **gần kín giường** | "Alternative" chỉ hiện khi **thật sự tốt hơn** (xong sớm hơn) |
| B7 | Verify suốt B1–B6 | **Không có ô chọn thợ**; arrangement/confirm/success **không hiện tên thợ**; lễ tân thấy mỗi khách 1 cột + add-on đúng |

## C. EDGE CASES
- Bấm **Back/Next** giữa các bước nhiều lần → state không vỡ.
- Đặt xong bấm **"Đặt lịch khác"** → reset sạch.
- Đổi ngày/giờ sau khi đã chọn add-on → add-on giữ/reset hợp lý.
- **2 tab** cùng đặt khung giờ cuối cùng → 1 cái báo "vừa có người đặt".
- **Mobile** (màn nhỏ) → giao diện không vỡ.

---

## 📋 Mẫu báo cáo (mỗi lỗi 1 dòng)
```
[Mã KB] Pass/FAIL | Mô tả ngắn | Bước tái hiện | Thực tế vs mong đợi | Lỗi console | Screenshot
```
Ví dụ:
```
A3 FAIL | giờ không cộng add-on làm sau | đặt Classic + Neck Massage | end vẫn 65′ thay vì 80′ | (no console err) | [ảnh]
```

## 🧹 Sau khi test
Báo lại danh sách lỗi (nếu có). **KHÔNG tự xoá booking test** — báo Huy để dọn bằng 1 lệnh.
