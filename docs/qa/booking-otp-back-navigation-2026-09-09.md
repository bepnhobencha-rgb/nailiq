# Booking OTP — ổn định nút Back khi nhận giá

Ngày: 2026-09-09. Nhánh: `fix/booking-otp-back-navigation-20260909`.
Base đã kiểm tra: `bc928106e972705e4ab65769319f0e8007f4dbd3` (main sau PR #1369).
Môi trường: build production-mode local, dữ liệu salon giả trong Supabase mới, timezone America/Los_Angeles, UI English. Chưa commit/push/PR/deploy lô này.

## Lỗi và bằng chứng

**Mức trung bình — lỗi giao diện đã tái hiện, sửa local.** Trên màn Review & confirm, thông báo “Verifying the current price…” bị tháo khỏi DOM khi nhận giá thành công. Nút Back phía dưới nhảy lên 44 px (margin 24 px + dòng chữ 20 px), nên phản hồi đến giữa lúc nhấn/thả con trỏ có thể làm hụt cú bấm.

Nguồn điều tra: main E2E run `34346567851`, ca mobile “a verified phone is not re-texted when navigating within the flow” trượt lần đầu, qua retry. Trace ghi quote bắt đầu 570242.954 ms, hoàn thành khoảng 570447.882 ms; Back click bắt đầu 570440.710 ms, hoàn tất 570450.733 ms. Điểm bấm y=635.82, sau phản hồi nút ở khoảng y=592. Đây là cơ chế phù hợp trace; không kết luận OTP bị mất hay dịch vụ SMS lỗi.

Tái hiện local trên build cũ:

1. Đi qua gate OTP bằng mã demo, chọn dịch vụ/thợ/ngày/giờ, nhập tên.
2. Giữ phản hồi thật của `/api/booking/quote` ở tầng Playwright (không giả giá).
3. Tại Review, kiểm tra Confirm bị khóa khi chờ giá, nhấn giữ Back.
4. Nhả phản hồi giá rồi thả con trỏ; đo vị trí và kiểm tra điều hướng.

Kết quả: Chrome và WebKit đều dịch **44 px**. Chrome tái hiện mất điều hướng; WebKit trong lần kiểm soát vẫn điều hướng được dù cùng dịch 44 px. Ca tự nhiên không điều khiển timing đã qua **10/10 lượt WebKit** trước sửa, do đó không gọi đây là tái hiện tự nhiên 100% của lỗi CI.

## Sửa

Giữ phần tử chứa thông báo giá trong layout và dùng `invisible` sau khi hết loading. Khi ẩn, bỏ `role=status` và đặt `aria-hidden=true`. Chiều cao tự theo nội dung dịch, giữ các token màu/spacing đang có. Không thay đổi giá, xác thực, điều kiện cho phép Confirm, resend OTP hoặc schema.

Thêm một ca E2E hồi quy kiểm tra phản hồi thật đến giữa pointer down/up: Confirm khóa/mở đúng, Back giữ vị trí, quay lại thấy tên đã nhập, trở lại Review không mở gate hoặc gửi thêm OTP. Assertions và ca cũ giữ nguyên, không tăng retry hay timeout.

## Kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| Tái hiện vị trí trên bản cũ, Chrome + WebKit | 2/2 FAIL đúng 44 px |
| Tái hiện giữ con trỏ trên bản cũ | 2/2 FAIL vị trí; Chrome đồng thời FAIL điều hướng |
| Ca kiểm soát sau sửa, 3 lượt mỗi trình duyệt, retries=0 | 6/6 PASS; dy=0 px cả 6 lượt |
| Toàn bộ booking-otp.spec.ts, hai trình duyệt, retries=0 | 20/20 PASS; 0 failed, 0 flaky, 0 skipped |
| Unit về authoritative pricing và quote API | 10/10 PASS |
| Webpack production-mode build | PASS |
| TypeScript sau build | PASS |
| ESLint hai file sửa | PASS |
| git diff --check | PASS |

Đã xem ảnh pending/settled: desktop Chromium 1280 px và mobile WebKit iPhone 14 390 px. Review, bảng giá và hai nút không bị cắt hoặc chồng lấn trong ảnh đã xem. Không suy rộng thành kiểm tra mọi màu/form, mọi locale, thiết bị Safari thật hay 784 chức năng.

Quan sát cần theo dõi riêng: ảnh Linux WebKit cho thấy ô mã quốc gia ở gate có nền sáng/chữ trắng tương phản thấp. Chưa xác minh trên iPhone/Safari thật hoặc Production; không gộp vào nguyên nhân layout Back, không sửa trong lô này.

## Giới hạn và an toàn

- Trình duyệt chạy Linux ARM64 qua Docker Playwright 1.59.1; app chạy macOS Node 20. Không phải bản sao toàn bộ GitHub Linux x64.
- Chỉ kiểm soát chuyển từ đang lấy giá sang lấy giá thành công. Các thông báo lỗi/đổi giá, add-on hoặc thay nội dung khác có thể thay đổi chiều cao; không tuyên bố tất cả layout shift đã hết.
- OTP demo và các cờ chặn email/SMS/calls bật trong local. Không thử gửi qua provider thật.
- Mọi ghi dữ liệu nằm trên DB local mới, không thao tác dữ liệu hai salon live.
- CI, Preview, Production của lô mới: **NOT_RUN**. PASS local không phải PASS Production hoặc đủ 784 chức năng.
- Dọn môi trường: `e2e_salons=0` sau suite; app đã dừng; Supabase stop --no-backup thành công; không còn container/volume của lô test. Colima đã dừng, xác nhận trở về trạng thái ban đầu.

## Bằng chứng

Artifact ngoài Git: `/Users/huytran/nailiq-audit-results-20260907/booking-otp-back-navigation/`.
`linux-baseline.json`, `controlled-before.json`, `pointer-before.json`, `pointer-navigation-before.json`, `controlled-after.json`, `full-otp-after.json`, `cleanup-db.json`, thư mục `*-artifacts`, `build-after.log`, `typecheck.log`, `lint.log`, `unit.log`.

Local helpers: `run-qa.py`, `run-linux.py`, `linux-runner.cjs`, `playwright.config.cjs`. Chạy test bằng runner local qua config trên; mỗi lần `--retries=0`, workers=1. `qa/local-status.json` chứa khóa tạm của DB local, không đưa vào Git/PR.
