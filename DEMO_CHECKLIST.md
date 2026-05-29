# NailIQ — Pre-Demo Checklist

> Chạy checklist này **30 phút trước** mỗi demo. Tổng thời gian: ~10 phút.

---

## ✅ Môi trường

- [ ] Wifi ổn định (test speed ≥ 10 Mbps — Lily cần realtime audio)
- [ ] Laptop sạc đầy hoặc cắm điện
- [ ] Điện thoại sạc ≥ 50% (demo Lily)
- [ ] Tắt notification điện thoại + laptop
- [ ] Mở sẵn tab: nailiq.ca/liam-nails và nailiq.ca/dashboard/liam-nails/center

---

## ✅ Data trong DB

- [ ] Salon **liam-nails** có ít nhất **3 staff** active
- [ ] Có ít nhất **5 dịch vụ** với giá và thời gian đầy đủ
- [ ] **Opening hours** đúng (không bị Closed cả ngày)
- [ ] **voice_ai_enabled = true** cho liam-nails
- [ ] Không có booking conflict nào ở giờ sẽ demo (kiểm tra dashboard)

**Quick check:**
```
curl -s https://www.nailiq.ca/api/health
# → {"status":"ok"}
```

---

## ✅ Booking flow (test trước)

- [ ] Mở nailiq.ca/liam-nails → đặt thử 1 lịch cá nhân → success screen hiện
- [ ] Booking vừa đặt xuất hiện trong dashboard/center
- [ ] Xoá booking test sau khi check (hoặc cancel)

---

## ✅ Walk-in queue

- [ ] Vào dashboard/center → click **+ Walk-in**
- [ ] Thêm "Test Guest" → chọn dịch vụ → Assign thợ → xuất hiện trong queue
- [ ] Xoá test entry sau khi check

---

## ✅ Voice AI — Lily

- [ ] Mở nailiq.ca/liam-nails trên điện thoại
- [ ] Tap icon mic → Lily connect được (không báo lỗi)
- [ ] Nói "I'd like to book a manicure" → Lily trả lời bằng tiếng Anh
- [ ] Thoát session

**Nếu Lily lỗi:**
- Thử lại 1 lần
- Nếu vẫn lỗi: skip Lily, nói "đang update version mới" — không demo live

---

## ✅ Group Booking + Party Link

- [ ] Mở nailiq.ca/liam-nails → chọn "Nhóm 👥" → size 2 → chọn dịch vụ
- [ ] Xong đến bước success → Party Link xuất hiện
- [ ] Test mở Party Link → 2 slot hiện ra
- [ ] Xoá group booking test sau khi check

---

## ✅ Chuẩn bị backup

- [ ] Có sẵn ảnh chụp màn hình / video demo phòng khi wifi chậm
- [ ] Biết trước pain point của chủ tiệm sắp gặp (hỏi qua Zalo/điện thoại trước)
- [ ] In QR code trỏ tới nailiq.ca/liam-nails (phòng khi họ muốn thử ngay)

---

## ✅ Sau demo

- [ ] Gửi link: nailiq.ca/liam-nails để họ tự thử
- [ ] Hỏi: "Muốn mình setup tiệm riêng không?" → nếu yes, lấy tên tiệm + số điện thoại
- [ ] Ghi chú feedback vào decisions-log.md hoặc Zalo

---

## 🚫 Checklist ABORT — Dừng demo nếu:

- Production down (`/api/health` không trả về `ok`)
- Dashboard không load được sau 15 giây
- Không có staff/dịch vụ nào trong liam-nails
- Wifi < 5 Mbps (Lily sẽ lag, ảnh hưởng ấn tượng đầu)
