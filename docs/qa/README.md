# Phòng QA — NailIQ

Nguyên tắc làm QA cho NailIQ, đồng bộ từ `CLAUDE.md` + `docs/testing.md`. **Đọc trước mỗi đợt test.** Mục tiêu: report đúng, không tái report lỗi đã fix, không nhầm hành vi đúng thành bug.

---

## 0. Nguyên tắc cốt lõi

- **Không gây side-effect trên dữ liệu thật.** Không submit/sửa/huỷ thật trên tenant khách (Hi-Lite…). Dùng dữ liệu test với SĐT/tên giả, dọn sau khi test. Nếu phải thao tác trên booking thật → dừng, hỏi trước.
- **Test trên build ĐÚNG.** Phần lớn "bug" trong các đợt gần đây thực ra là **build cũ trong tab** — phải verify (mục 1) trước khi viết report.
- **Ngôn ngữ report: tiếng Việt.** Kèm mức độ + trạng thái fix + bước tái hiện.

---

## 1. ⚠️ BẮT BUỘC trước khi report bug — Checklist xác minh

> Nhiều report bị "false" vì 3 nguyên nhân dưới. **Loại trừ cả 3 trước khi kết luận là bug.**

| # | Bẫy | Cách loại trừ |
|---|---|---|
| 1 | **Bundle JS cũ trong tab** (deploy lag / cache) | **Hard-refresh** (Cmd/Ctrl-Shift-R) rồi test lại. NailIQ auto-deploy từ `main` — sau khi dev báo "đã fix + merge", đợi ~1–2 phút cho Vercel deploy **rồi mới re-test**. Nếu nghi build cũ: mở DevTools → Network → tải lại, hoặc so commit deploy với fix. |
| 2 | **Lệch timezone (giờ máy ≠ giờ tiệm)** | Ngày/giờ trong NailIQ là **giờ TIỆM** (vd Hi-Lite = America/Los_Angeles), KHÔNG phải giờ máy QA. Tester ở VN (UTC+7) buổi tối sẽ thấy "hôm nay/ngày mai" lệch so với tiệm. **Trước khi báo "ngày sai" → tự tính ngày hiện tại theo giờ tiệm.** App phải dùng `salonTime.ts`, không `new Date()` trực tiếp. |
| 3 | **Test E2E đỏ sẵn (flake)** | Nhiều spec đỏ/flaky có sẵn trên `main` (`e2e/booking.spec.ts`, party golden-path, `grid-render case 11: ghost assign`, mobile receptionist-center). **Đỏ trùng signature trên `main` = KHÔNG phải lỗi của PR.** Re-run; flake do parallel/seed-wallclock thường pass khi chạy lại hoặc `--workers=1`. |

**Sau 3 bước trên mà vẫn lỗi → mới là bug thật.** Ghi rõ: đã hard-refresh, giờ tiệm lúc test, build/commit nếu biết.

---

## 2. Gotchas riêng của NailIQ (đừng nhầm thành bug)

- **Trạng thái terminal:** booking `Hoàn thành` / `Đã huỷ` không có nút Sửa/Huỷ — **đúng thiết kế**, không phải thiếu nút.
- **SĐT bị che (`***-**-1234`)** + nút "Hiện số" — **đúng** (privacy), không phải lỗi render.
- **Phân quyền theo role:** owner/admin/senior/receptionist/nail_tech khác nhau. `nail_tech` = view-only (không Sửa/Huỷ/drag/Start-Complete). Nút bị ẩn theo role là **đúng**, không phải mất nút. Xem `docs/PERMISSION_MATRIX.md`.
- **Multi-tenant:** mỗi salon (slug) độc lập; feature-flag/cấu hình khác nhau → hành vi khác nhau giữa các tiệm là **bình thường**, không phải bug. Xem `docs/FEATURE_FLAGS.md`.
- **Lưới ngày tự co giãn quanh "Bây giờ"** (`computeHourRange`): cột giờ đầu/cuối đổi theo thời điểm test — bình thường.
- **Báo cho khách (notify):** thao tác staff (tạo/dời/huỷ) gửi tin qua **hàng đợi + cron ~1 phút** (không tức thì); Undo trong cửa sổ chặn gửi. Tin "đến trễ ~1 phút" là **đúng cơ chế**.
- **Clipboard/automation:** "Sao chép link" có thể timeout trong môi trường automation (thiếu user-gesture) — giới hạn của test runner, không phải lỗi app.

---

## 3. Cách phân loại + ghi report

- **Mức độ:** 🔴 Cao (chặn / sai dữ liệu / gửi sai khách) · 🟠 TB · 🟢 Thấp / cơ hội UX.
- **Phân biệt rõ:** Lỗi chặn (phải fix) vs Cơ hội cải thiện (UX/wow) vs Đã đính chính (không phải bug).
- **Mỗi mục cần:** khu vực · mô tả · **bước tái hiện** · mức · (nếu biết) trạng thái fix / commit / branch.
- **Trước khi kết luận "chưa fix":** đối chiếu mục 1 — đã hard-refresh + đúng giờ tiệm + không phải flake chưa?

---

## 4. Công cụ test (an toàn, không đụng khách thật)

- **Demo-cookie bypass** (dev/local): `NEXT_PUBLIC_DEMO_OTP=true DEMO_OTP=true NAILIQ_TEST_BYPASS_SLUG_PIN=1 npm run dev` + cookie `nailiq-demo-slug=<slug>` → vào dashboard gated với role owner mà không cần login thật. Verify demo mode **TẮT** trên prod.
- **E2E:** `e2e/` (Playwright). Xem `docs/testing.md`.
- **Đối chiếu DB** (read-only) qua Supabase khi cần xác minh dữ liệu thật — không sửa.

---

## 5. Lưu report ở đâu

- Đặt file vào `docs/qa/` với tên `<khu-vực>-<YYYY-MM-DD>.md` (vd `receptionist-center-2026-05-30.md`).
- Một report = một phiên/khu vực. Ghi rõ: ngày, build/commit test, ngôn ngữ UI, phạm vi.

---

## 6. Tham chiếu

- `CLAUDE.md` (§ Testing, § Timezone, § Deploy, § Preview-first) — nguồn gốc các rule trên.
- `docs/testing.md` · `docs/PERMISSION_MATRIX.md` · `docs/FEATURE_FLAGS.md` · `docs/ARCHITECTURE_OVERVIEW.md`.

> Nguyên tắc vàng: **hard-refresh + đúng giờ tiệm + loại flake** trước khi gọi là bug. Khi nghi ngờ — verify, đừng đoán.
