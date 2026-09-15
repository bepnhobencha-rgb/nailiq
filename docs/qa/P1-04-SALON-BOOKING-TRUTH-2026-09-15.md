# P1-04 — Cấu hình và booking truth từng salon

**Ngày kiểm tra:** 2026-09-15

**Nhánh local:** `audit/p1-04-booking-truth-20260915`

**Base SHA:** `a0750a4f74f695dcafc4c17d8f19b72d376807b4`

**Production `/api/version`:** `a0750a4f74f695dcafc4c17d8f19b72d376807b4` tại thời điểm kiểm tra

**Kết luận kỹ thuật:** `PASS_LOCAL_QA`

**Kết luận đóng P1-04:** `NOT_PROVEN` cho đến khi từng salon pilot xác nhận cấu hình thực tế và cùng ký biên bản rehearsal.

## Phạm vi và ranh giới an toàn

- Chỉ dùng Supabase local disposable, salon/khách synthetic và trình duyệt Playwright thật.
- Outbound SMS, email và call tắt; payment/provider dispatch tắt.
- Không đọc hoặc sửa tenant Production, không gọi provider Production, không tạo booking thật.
- Không có migration hoặc thay đổi product runtime trong nhánh này. Các sửa đổi chỉ làm test phản ánh đúng hành vi hiện tại và làm fixture chạy được trên database mới hoàn toàn.

## Hai trạng thái salon đã diễn tập

| Trạng thái | Bằng chứng | Kết quả |
|---|---|---|
| Salon trống | 0 services/0 staff; service nhưng chưa có staff; Guided Setup mới và resume | PASS |
| Salon tương đương pilot | Catalog, giá, nhân viên, giờ, ngày đóng cửa, giường/tài nguyên, booking public/desk, readiness và owner attestation | PASS |

## Ma trận acceptance P1-04

| Tiêu chí | Bằng chứng | Kết quả |
|---|---|---|
| Public catalog khớp cấu hình | UI hiển thị `Gel Manicure` và `$45.00`; booking hoàn tất desktop/mobile | PASS |
| Any Staff | Slot còn mở khi ít nhất một nhân viên phù hợp còn rảnh | PASS unit |
| Specific Staff | Break chặn đúng slot của nhân viên; không ảnh hưởng nhân viên khác | PASS unit |
| Ngày nghỉ/đóng cửa | Calendar vô hiệu ngày đóng; outside-hours trả empty state | PASS browser |
| DST và biên ngày | Ngày Vancouver half-open đúng ở ngày thường và DST | PASS unit |
| Giờ đóng cửa | Không tạo nếu dịch vụ không kịp kết thúc; cho kết thúc đúng phút đóng cửa; after-hours cần Owner + staff consent | PASS browser/unit |
| Giường/tài nguyên | Giường bận bị khóa; chọn/auto-assign/edit lưu đúng `resource_id`; thiếu inventory fail closed | PASS browser/unit |
| Race/double-book | Public RPC và walk-in tranh cùng slot: chỉ một bên thắng, không có block giả trên grid | PASS browser |
| Mạng yếu/response loss | Một create mutation, một booking, read-only receipt recovery, không replay create, không duplicate | PASS browser |
| Thay đổi cấu hình | Đổi giá làm stale toàn bộ attestation cũ; phải xác nhận prerequisites và Owner approve lại | PASS browser |
| Tenant/role boundary | Lower role và cross-tenant owner bị chặn khỏi safe preview; Admin không thể final approve | PASS browser |
| Owner sign-off salon thật | Cần Owner của từng salon kiểm tra dịch vụ, giá, staff, giờ, ngày nghỉ, resource và chạy rehearsal | OPEN |

## Lỗi test được tìm thấy và sửa local

1. Fresh Supabase không có global category `other`, làm fixture insert service lỗi FK. Đã gom bootstrap idempotent vào `ensureDefaultServiceCategory()` và dùng lại ở các fixture.
2. Go-live test khóa cứng tiếng Việt trong khi locale hiện tại là tiếng Anh. Đã dùng locator song ngữ.
3. Go-live test cũ cho rằng đổi giá chỉ làm stale Owner approval. Runtime hiện tại ràng buộc mọi human attestation với technical snapshot; test đã được sửa để xác nhận lại ba prerequisite trước Owner approval và kiểm tra đủ tám audit events.
4. Poor-network test giả định phải bấm Confirm lần hai. Luồng hiện tại an toàn hơn: chuyển sang `/booking/recover-booking`, đọc receipt, rồi xác nhận appointment; không gọi lại create mutation. Test nay kiểm tra đúng hành vi này.
5. Poor-network test bắt SMS consent luôn tồn tại dù consent là conditional. Đã dùng helper chỉ chấp nhận khi form thực sự hiển thị.
6. Booking E2E chưa chứng minh giá public nhìn thấy khớp fixture. Đã thêm assertion tên dịch vụ và `$45.00` trước khi đặt.

## Kết quả kiểm thử

- Browser desktop/mobile:
  - Go-live readiness: **8/8 PASS**.
  - Poor-network read-only recovery: **1/1 PASS**; `createAttempts=1`, `rowsAfterRecovery=1`, `duplicateRows=0`, recovery khoảng 1.3 giây.
  - Booking/shift/closed-day/closing-boundary/empty-salon/race: **23 PASS, 3 SKIP theo project**.
  - Guided Setup và Bed/Room: **28/28 PASS**.
  - Tổng các lượt cuối: **60 PASS, 3 SKIP theo thiết kế, 0 FAIL**.
- Focused booking unit: **32/32 PASS**.
- Time-slot acceptance script: **25/25 PASS**.
- ESLint sáu file test/helper chạm tới: **PASS**.
- `npm run build`: **PASS**.
- `npm run typecheck` chạy sau build: **PASS**.

## Cảnh báo không chặn kết quả

- Next.js cảnh báo Edge Runtime deprecated.
- Dev browser cảnh báo nhiều GoTrueClient dùng cùng storage key trong một số route.
- Next dev đôi lúc log destination stream closed early khi Playwright chuyển trang; toàn bộ test liên quan vẫn PASS.

Ba cảnh báo này cần theo dõi riêng, nhưng không tạo sai booking, sai giá hoặc duplicate trong ma trận P1-04 vừa chạy.

## Điều kiện để đóng P1-04

Cho từng salon pilot, Owner cần xác nhận ngay trên snapshot hiện tại:

1. Tên salon, địa chỉ và timezone.
2. Dịch vụ active, duration/buffer và giá hiển thị public.
3. Staff active, capability, shift, break và ngày nghỉ.
4. Bed/room/resource mapping nếu salon bật resource mode.
5. OTP/consent/no-show policy đúng quyết định salon.
6. Một booking rehearsal bằng dữ liệu synthetic hoặc lịch do salon dành riêng, kiểm tra UI và DB receipt, rồi cleanup.
7. Owner ghi ba prerequisite attestations và final approval trên Go-live readiness.

Không xem code/CI xanh là chữ ký của salon. Không thay đổi Production trong bước xác nhận nếu chưa có phê duyệt thao tác live rõ ràng.

## Rollback

Nhánh chỉ đổi test/helper. Có thể rollback bằng cách bỏ sáu file test/helper và tài liệu này; không có database rollback, tenant rollback hoặc provider rollback. Production hiện chưa nhận các thay đổi local này.

## Phân loại bằng chứng

- **Existing before task:** runtime booking/read-only recovery/readiness ở SHA `a0750a4f`.
- **Implemented locally:** fixture category bootstrap và cập nhật test theo contract runtime hiện tại.
- **QA tested:** PASS trên Supabase local disposable và desktop/mobile browser.
- **Preview verified:** chưa thực hiện.
- **Deployed:** chưa.
- **Production verified:** chỉ xác minh SHA Production; chưa diễn tập P1-04 trên salon live.
