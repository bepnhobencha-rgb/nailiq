# AUTH-FORM-PREHYDRATION — kiểm tra và bản sửa cục bộ

Ngày: 2026-09-10. Mức độ: trung bình. Trạng thái: **LOCAL PASS**;
chưa commit, push, chạy CI/Preview hoặc triển khai lô này.

Nền kiểm tra: `e50b023ee3d6187e861d6b6b20d99e6b86241096` (bản sửa cookie
#1390 đã phát hành). Nhánh: `fix/auth-form-readiness-20260910`.

## Lỗi và cách tái hiện

Form email/mật khẩu được hiển thị trước khi JavaScript gắn bộ xử lý nhập liệu.
Các nút đã chờ form sẵn sàng, nhưng hai ô nhập vẫn mở. Nội dung nhập trong
khoảng này có thể bị cập nhật React đầu tiên xóa vì trạng thái vẫn rỗng.

Trong fixture dùng component thật, giữ các script Next tại trình duyệt, mở
`/auth?surface=login` và kiểm tra lúc `data-hydrated=false`. Bản nền có ô email
vẫn enabled: bài kiểm tra thất bại đúng tiêu chí trên cả Chromium và WebKit
(2/2 RED). Đây là tái hiện có chủ động làm chậm script, không phải kết luận
mọi lượt đăng nhập thật đều gặp lỗi. Chẩn đoán mất nội dung trước đó của lô
cookie được giữ riêng trong `auth-cookie-secure/linux-hydration-diagnostic.spec.txt`.

## Bản sửa

Thêm `disabled={!isHydrated}` vào email và mật khẩu trong
`SocialAuthButtons.tsx`, dùng đúng tín hiệu sẵn sàng vốn có của các nút.
Ô nhập mở khi bộ xử lý đã tồn tại. Giữ nguyên quy tắc xử lý khi đang gửi,
autocomplete, cách gửi yêu cầu, cấu trúc form và thông báo. Khi chưa sẵn sàng,
ô nhập dùng kiểu mờ của trạng thái disabled sẵn có; khi sẵn sàng trở về màu cũ.

Không sửa session, cookie, phân quyền, database, cấu hình Production hoặc
luồng đặt lịch. Không thêm hiệu ứng/hook hay che cảnh báo hydration.

## Kết quả kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| Bản nền, chặn script | 2 thất bại đúng tiêu chí cần sửa |
| Trình duyệt sau sửa | **88/88 PASS**, 0 bỏ qua, 0 flaky, retries=0 |
| Trong đó: bài mới về form sẵn sàng | 26 PASS |
| Trong đó: hồi quy form reset mật khẩu | 62 PASS |
| Unit toàn dự án | **4.742 PASS**, 1 bỏ qua sẵn có |
| Build fixture + build ứng dụng | PASS |
| Typecheck, chạy sau build | PASS |
| Lint toàn dự án | 0 lỗi, 41 cảnh báo |
| Lint tệp thay đổi | 0 lỗi, 1 cảnh báo đã có ở bản nền về điều hướng sau đăng nhập |
| Kiểm tra hình ảnh và kích thước | 8 form sẵn sàng + 2 trạng thái chờ script đã kiểm tra |

Các bài mới bao phủ đăng nhập/đăng ký/email-link khi chậm script, form thu
gọn và autofocus, phím Enter, tránh gửi trùng khi còn chờ, giữ nội dung sau
phản hồi 503, tiếng Anh/Việt và trường hợp JavaScript không tải.

Lượt chạy đầu sau sửa có 68 PASS và 20 lỗi **ở bài test**: locator `alert`
không phân biệt thông báo form với thông báo chuyển trang của Next. Cả 20
cùng một nguyên nhân; đã giới hạn locator vào component rồi chạy lại đủ 88.
Log và trace của lượt đỏ được giữ lại, không tính là 20 lỗi sản phẩm.

## Màu sắc và bố cục

Đã mở và xem ảnh 8 form đăng nhập/đăng ký × Anh/Việt × Chromium desktop
(1280px) / WebKit iPhone giả lập (390px). Không tràn ngang hoặc lỗi JavaScript.
Hai ô dùng cùng màu nền, chữ, viền và bo góc; sau hiệu ứng chuyển trạng thái,
opacity đều bằng 1. Hai mẫu chặn script giữ nguyên kích thước/vị trí ô email
khi mở lại. Trạng thái nút đăng ký bị mờ khi mật khẩu rỗng là quy tắc có sẵn.

Ảnh đăng nhập tiếng Anh trước/sau có cùng kích thước, vùng hai ô nhập không
đổi pixel. Khác biệt ảnh toàn trang chỉ nằm ở dòng gửi link đăng nhập dưới
form, nên không tuyên bố toàn bộ ảnh giống hệt. Kiểm tra này giới hạn trong
component của fixture, không chứng nhận toàn bộ màu sắc của ứng dụng.

Lần chụp trạng thái chặn script đầu tiên chờ `document.fonts.ready` và hết
thời gian. Script chụp ảnh đã bỏ riêng bước chờ font cho trạng thái cố ý chưa
tải xong này; ảnh form sẵn sàng vẫn đợi font và hiệu ứng opacity hoàn tất.
Đây là điều chỉnh công cụ chụp ảnh, không sửa sản phẩm hoặc bài test hồi quy.

## An toàn và giới hạn bằng chứng

Fixture dùng CSS và component thật nhưng thay các action Auth/client bằng
stub không kết nối dịch vụ. Cả hai spec kiểm tra danh sách chính xác 5 action
stub trong manifest; browser chặn request gửi và điểm đến ngoài fixture.
Không dùng thông tin khách, gọi nhà cung cấp, gửi email/SMS hoặc sửa salon thật.

Đây là bằng chứng về hành vi component cục bộ. Chưa chứng minh đăng nhập
Auth thật, tự điền bằng trình quản lý mật khẩu, CI/Preview hoặc Production
của lô mới. Nếu JavaScript không tải, các ô giữ trạng thái khóa giống các nút;
bản sửa không cung cấp đăng nhập khi tắt JavaScript.

Số 88 là lượt test của nhóm component này; không cộng thành chức năng mới
hoặc coi là hoàn thành toàn bộ 784 chức năng.

## Bằng chứng và bước tiếp theo

Artifact máy thử nằm tại
`/Users/huytran/nailiq-audit-results-20260907/auth-form-readiness/`:
`baseline-results.json`, `baseline-artifacts/`, `final-browser-results.json`,
`alert-locator-initial-results.json`, `alert-locator-initial-artifacts/`,
`unit.log`, `build.log`, `typecheck.log`, `lint.log`, `touched-lint.log`.
Ảnh và thông số: `*-ready.png`, `*-before-js.png`, `visual-results.json`,
`baseline-visual-comparison.json`. Các lần thử công cụ được lưu riêng.

Kiểm tra chỉ đọc cuối lượt: `main` và `https://www.nailiq.ca/api/version`
đều trả về `e50b023ee3d6187e861d6b6b20d99e6b86241096`. Không có thay đổi
Production hoặc dữ liệu hai salon từ lô này.

Fixture có hướng dẫn tại `qa/password-reset-form/README.md` và đã nằm trong
job CI hiện có. Sau khi duyệt phát hành riêng lô này: commit, push nhánh và
mở draft PR để chạy CI/Preview; chưa merge/deploy.
