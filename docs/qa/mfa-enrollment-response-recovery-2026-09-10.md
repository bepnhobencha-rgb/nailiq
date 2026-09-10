# Khôi phục bật, xác nhận và tắt MFA — 2026-09-10

**Kết luận: PASS trong phạm vi local; chưa phát hành.** Inventory mục 50. Nhánh `fix/mfa-enrollment-response-recovery-20260910`, base `cc2f7af4a306abfa202805df22ac32dda23557da` (main sau PR #1387).

## Lỗi và cách sửa

| Ưu tiên | Bằng chứng trước sửa | Hành vi sau sửa |
|---|---|---|
| P1 | Abort tại cả ba thao tác làm mất form vào error boundary; 3 ca Chromium thất bại trên bản gốc | Bắt lỗi request, đọc lại trạng thái, cho thử lại thủ công; không tự gửi lại mutation |
| P1 | Code server bỏ qua lỗi đọc/dọn factor, gộp lỗi hạ tầng thành sai mã và có thể chấp nhận phản hồi thiếu data | Dừng khi đọc/dọn chưa xác nhận; phân biệt sai mã với dịch vụ gián đoạn; không báo thành công khi thiếu data |
| P1 | Form chưa xử lý kết quả không chắc chắn sau mất phản hồi | Chỉ hiển thị kết quả ON/OFF sau đọc lại; nếu đọc lỗi thì ẩn thao tác và secret, cho thử đọc lại |
| P2 | Enter không gửi mã (1 ca baseline thất bại); input/Cancel chưa khóa khi pending qua kiểm tra code | Form có label, Enter và autofill; khóa input/Cancel/submit, chặn nhấn lặp |

Các nút dùng Button và token màu có sẵn; vùng chạm kiểm tra tối thiểu 44 px. Đã xem ảnh form lỗi 320 px và iPhone WebKit; không tràn ngang ở các ca lỗi được kiểm tra. QR/secret trong ảnh là dữ liệu giả.

## Kiểm tra

- **309/309 unit test Auth/SuperAdmin, 32 files PASS**, gồm **44 test mới** của ba action.
- **132/132 kiểm tra giao diện PASS**, không skip/flaky/retry: **87 enrollment + 27 challenge + 18 status**, trên Chromium desktop, Chromium 320 px và iPhone WebKit.
- Baseline: 4/4 ca được chọn FAIL trên component trước sửa, gồm 3 abort và Enter. Lượt sau đầu tiên: 99 PASS, 6 FAIL do test chèn lỗi đọc trước khi trạng thái ban đầu tải xong; đã sửa điều kiện chờ, giữ log và chạy lại toàn bộ cùng 27 kiểm tra bổ sung.
- Build fixture và build ứng dụng PASS; typecheck PASS.
- Lint file sửa PASS; lint toàn bộ 0 error, 41 warning có sẵn.
- CI YAML hợp lệ, job MFA hiện có dùng config mở rộng. `git diff --check` PASS.

## Rà soát lần hai

- Quyền vẫn kiểm tra qua active SuperAdmin session trước mọi SDK operation; phân biệt Auth outage với phiên bị từ chối.
- Dọn duy nhất TOTP factor chưa verified theo hành vi cũ; không thay policy MFA, shell assurance, database/RLS hay code salon.
- Thử lại sau lỗi là hành động của người dùng. Đọc trạng thái không tạo/xóa factor.
- Hết phiên ẩn QR/secret, có link đăng nhập. Sai mã đã xác nhận mới xóa input; lỗi dịch vụ giữ input khi trạng thái OFF còn xác minh được.
- Browser fixture thay toàn bộ MFA actions bằng stub; chặn external traffic và mọi action ngoài danh sách của từng ca. Unit test dùng Auth client giả.

## Giới hạn và phát hành

**NOT_PROVEN:** TOTP/QR thật, enroll/verify/unenroll với Auth thật, cookie/AAL2 sau mất phản hồi, mọi tình huống đa phiên, hành vi Production của bản sửa này. Mô phỏng mất phản hồi bỏ response sau stub thành công rồi mô hình hóa trạng thái đọc lại; không chứng minh provider thật.

Chưa commit, push, mở PR, merge hoặc deploy bản sửa này. Không có thao tác Auth/provider hoặc dữ liệu khách thật. Hai salon live không được dùng để thử mutation. Không thay đổi tổng hoàn thành 784; số test không phải số chức năng hoàn thành 100%.

Bằng chứng local: `/Users/huytran/nailiq-audit-results-20260907/mfa-enrollment-recovery/` — JSON browser, log build/typecheck/lint/unit, ảnh baseline và ảnh sau sửa, `local-checkpoint.json` và hash các file.
