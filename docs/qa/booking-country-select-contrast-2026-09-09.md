# QA: sửa tương phản ô chọn quốc gia — 2026-09-09

Trạng thái: **PASS_LOCAL — chưa commit/push/PR/deploy**.
Nhánh: `fix/booking-country-select-contrast-20260909`.
Mã nguồn nền: `1f8ef97aebf028f16cc90586a967d4f2f7de4e74`.

## Lỗi đã xác nhận và bản sửa

Ở WebKit trên Linux, khi booking dùng theme tối, ô chọn quốc gia có chữ trắng
nhưng trình duyệt vẽ nền gần trắng `[244,244,244]`: tương phản chỉ **1.10:1**.
Ô điện thoại bên cạnh vẫn có nền tối đúng `[57,54,47]`. CSS trả về màu nền đúng
nhưng cách vẽ native của select ghi đè nền hiển thị. Lỗi được tái hiện trên bản
build mới từ SHA nền, không liên quan ngày/giờ hoặc dữ liệu salon.

Bản sửa cục bộ trong `CountryPhoneField.tsx` dùng `appearance-none` cho ô chọn,
bổ sung ChevronDown theo màu chữ của theme và chừa khoảng trống cho mũi tên.
Wrapper giữ độ rộng 78/150 px và chế độ xếp dọc dưới 280 px. Mũi tên không chặn
sự kiện chuột, không tạo thêm phần tử focus và được ẩn khỏi accessibility tree.
Ô chọn vẫn là native select, giữ nguyên các option và xử lý số điện thoại.

Mức độ: trung bình trên môi trường tái hiện — khó đọc mã quốc gia.
Không khẳng định lỗi này xảy ra trên iPhone thật; ảnh WebKit Linux không phải
bằng chứng tương đương Safari trên thiết bị Apple.

## Kết quả trước và sau

| Kiểm tra | Kết quả |
| --- | --- |
| Trước sửa: macOS Chromium + WebKit, 24 cấu hình | PASS, tương phản 12.05–14.88:1 |
| Trước sửa: Linux Chromium + WebKit, 24 cấu hình | FAIL: 6 cấu hình WebKit tối không đủ tương phản; cả 12 cấu hình WebKit lệch nền |
| Sau sửa: macOS, bộ Playwright mới | **32/32 PASS**, 0 skip, 0 retry, 0 flaky |
| Sau sửa: Linux, bộ Playwright mới | **32/32 PASS**, 0 skip, 0 retry, 0 flaky |
| Config tự khởi động/dừng server, smoke trên hai engine | **2/2 PASS** |
| Smoke logic quốc gia/số điện thoại (`tsx`) | **23/23 PASS** |
| Smoke biến màu theme (`tsx`) | **5/5 PASS** |
| Next production build toàn ứng dụng (`--webpack`) | PASS |
| Next production build fixture | PASS |
| Typecheck | PASS |
| Lint các file sửa | PASS, 0 lỗi/cảnh báo |
| Lint toàn repo | PASS: 0 lỗi; 42 cảnh báo ở file ngoài phạm vi sửa |
| Parse YAML và cấu trúc job CI mới | PASS |

64 trường hợp sau sửa là số **cấu hình kiểm thử component**, không phải 64 chức
năng khác nhau và không cộng vào tuyên bố hoàn tất toàn bộ 784 chức năng.

Bộ test dùng component, stylesheet và hàm tạo theme thật; ma trận gồm hai engine,
EN/VI, sáng/tối và độ rộng 260/320/390/1024 px. Mỗi ca kiểm tra:

- Tương phản chữ/nền >= 4.5:1 bằng pixel ảnh hiển thị; nền khớp ô điện thoại.
- Không tràn ngang, chiều cao tương tác >= 44 px.
- Mũi tên hiển thị và điểm bấm đi vào select.
- Focus có dấu hiệu hiển thị; Tab chuyển sang ô điện thoại.
- Mở danh sách đầy đủ, chọn VN, nhập số và nhận `+84912345678`.
- Trở lại khu vực/CA, nhận `+16045550123`, đổi US giữ đúng số +1.
- Trạng thái lỗi có viền khác, giữ đúng tương phản, mô tả lỗi cho ô điện thoại.
- Không có lỗi JavaScript trên trang.

## CI, Preview và Production

Đã thêm job `Booking country phone browser` vào workflow CI. Job build fixture
riêng và chạy Chromium/WebKit không có database/Auth/provider credentials.
Chưa push nên **CI GitHub và Preview của bản sửa này chưa chạy**.
Fixture có ignore riêng cho output build; lint chỉ bỏ qua file sinh tự động,
không bỏ qua source hoặc test.

Bằng chứng Production ở lượt điều tra trước trong cùng ngày: 6 lượt chỉ đọc
(ba đường dẫn × Chromium/WebKit trên macOS) đều có ô chọn đọc rõ, theme sáng:
`/tech-nails-langley`, `/hilite-anaheim`, `/hilite-studio`.
Đây là ba đường dẫn, không phải tuyên bố ba doanh nghiệp riêng biệt.
Không chạy lại hay gắn kết quả đó cho bản sửa chưa phát hành.

Không submit booking, gửi OTP/SMS/email, thanh toán hoặc sửa dữ liệu khách thật.
Bản sửa không đổi API, quyền, schema, xác thực hay cách tạo số E.164. Fixture và
trình duyệt kiểm thử chỉ cho phép GET/HEAD cùng origin local.

## Rà soát lần hai và giới hạn

PASS cho phạm vi local đã đo: không thêm effect/state vào component sản phẩm;
không đổi event handler, option, tên truy cập hoặc giá trị số điện thoại; màu và
kích thước vẫn lấy từ hệ thống booking; native selector giữ thao tác bàn phím.
Đã xem ảnh Chromium và ảnh WebKit Linux ở theme tối sau sửa.

Chưa chứng minh trên iPhone thật, mọi phiên bản trình duyệt, mọi màu thương hiệu,
menu chọn native ở mọi OS, hay toàn bộ luồng booking có database. Chưa chạy lại
full-suite E2E/784 chức năng. Cần CI và Preview trước khi xem xét merge/phát hành.

## Bằng chứng và tái hiện

Artifact root:
`/Users/huytran/nailiq-audit-results-20260907/booking-country-select-contrast`.

- `REPORT-investigation.md`: kết quả điều tra trước sửa.
- `macos-audit.json`, `linux-audit.json`: baseline 24 cấu hình mỗi nền tảng.
- `linux-diagnostic-audit.json`: thí nghiệm bỏ native appearance, không phải bản sửa.
- `macos-fixed-results.json`, `linux-fixed-results.json`: 64 kết quả sau sửa và ảnh.
- `managed-server-results.json`: kiểm tra config khởi động/dừng fixture.
- `linux-fixed-webkit-390-dark-en.png`, `fixed-agent-browser.png`: ảnh đã xem.
- `fixed-main-build.log`, `fixture-build-fixed.log`, `fixed-typecheck.log`,
  `fixed-lint.log`, `fixed-full-lint.log`, `fixed-phone-unit.log`, `fixed-theme-unit.log`.

Chạy lại theo `qa/booking-country-phone/README.md`. Linux đã kiểm chứng bằng
image `mcr.microsoft.com/playwright:v1.59.1-noble`, macOS dùng Playwright 1.59.1.
Node 20 dùng cho build; bộ browser local dùng Node 24.15.0/macOS và runtime
Node trong image Linux. CI khai báo Node 20; kết quả CI chưa có.

## Theo dõi xuất bản — PR #1371

Commit sản phẩm `1780ac8720f8ad8b920cd993a4774c9c697c7002` đã được push sau khi
Huy duyệt. Preview `dpl_32Hib85AWiacwcteKPiGXwBstmGZ` READY và 6/6 lượt kiểm tra
chỉ đọc xác nhận đúng SHA, select dùng nền mới và mũi tên hiển thị.

CI lần đầu: Build & Type Check và Security Audit PASS. Tám job có trình duyệt
thất bại trước bước test vì APT Google Chrome trả `Hash Sum mismatch` ở
`main/binary-amd64/Packages.gz`. Cả job reset-password có sẵn cũng gặp lỗi này.
Đã đối chiếu log từng job và tải lại Release/Packages.gz: SHA256 vẫn không khớp.
CI: `34385933643`; E2E: `34385933650`. Lượt retry hạ tầng được ghi riêng, không
được tính là test browser chạy lại do flake.

Lượt kế tiếp trên commit `23e32226` chạy 32/32 test country-phone thành công,
nhưng upload báo cáo không tìm thấy file. Đã sửa config để reporter và thư mục
artifact dùng đường dẫn tuyệt đối dưới `test-results/booking-country-phone/`,
đồng thời cho bước upload thất bại nếu thiếu file. Smoke local xác minh đường
dẫn mặc định, không dùng biến môi trường thay đường dẫn.

Đính chính điều tra APT: log lượt PASS vẫn tải nguồn Google Chrome. Vì vậy không
có bằng chứng thao tác xóa hai tên file nguồn legacy là nguyên nhân phục hồi;
workaround đó đã được gỡ. Các bước cài browser giữ nguyên cách cài Playwright
ban đầu. Không tắt xác minh hash/chữ ký và không nới assertion/retry/timeout.
Lỗi APT lần đầu vẫn được lưu như lỗi hạ tầng xảy ra trước khi chạy test.
