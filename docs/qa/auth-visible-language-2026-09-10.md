# NailIQ — đồng bộ ngôn ngữ form đăng nhập và khôi phục mật khẩu

Ngày: 2026-09-10. Trạng thái: **LOCAL PASS**. Chưa commit/push, mở PR,
chạy CI/Preview hoặc triển khai lô này.

Nhánh `fix/auth-language-20260910`, nền
`93e8be2aa3e8d01ef4fa7582b73adaa843c80558` (PR #1391 đã phát hành).
Tiếp tục mục ngôn ngữ của luồng Auth và yêu cầu kiểm tra tính đồng bộ form.

## Lỗi và bản sửa

Chọn tiếng Việt nhưng ba form SuperAdmin đăng nhập, quên mật khẩu và đặt lại
mật khẩu vẫn dùng chuỗi tiếng Anh hoặc ghép Anh/Việt. Tiêu đề/hướng dẫn đặt
mật khẩu của chủ salon cũng cố định tiếng Anh. Câu nhắc quay lại đăng nhập
của chủ salon hiển thị thành câu hỏi về địa chỉ email.

Tái hiện trên fixture dùng component thật tại bản nền: 3 nút gửi × Chromium
và WebKit, **6/6 thất bại đúng tại chuỗi tiếng Việt mong đợi**. Sau sửa, cùng
6 ca đạt. Các chuỗi tiêu đề và câu nhắc được xác định thêm qua đối chiếu code;
không tính chúng thành ca RED trình duyệt đã chạy.

Bản sửa dùng chung lựa chọn ngôn ngữ hiện có cho tiêu đề, hướng dẫn, nhãn,
thông báo và lỗi. Markup tiêu đề/thông báo được chuyển vào export client của
module form có sẵn. Lỗi đăng nhập lưu khóa trạng thái thay vì câu dịch để
thông báo đang hiển thị, hoặc đến sau khi đổi ngôn ngữ, đều dùng tiếng mới.
Chủ salon dùng các khóa dịch có sẵn và hai khóa bổ sung cho hướng dẫn/câu nhắc.

Giữ nguyên các CSS class, primitive, khoảng cách, màu, handler gửi yêu cầu,
điều hướng, giới hạn mật khẩu và trạng thái chờ. Không sửa action Auth, logic
session/role/membership, cookie, schema, booking, thanh toán hoặc cấu hình phát
hành. Các điều kiện kiểm tra phía server vẫn chạy trước khi trả UI. Hai lỗi
`invalid_credentials` và `no_role` vẫn hiển thị cùng một thông báo chung.

## Kết quả kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| Bản nền: 3 nút VI × 2 engine | 6 FAIL đúng lỗi cần sửa |
| Cùng 6 ca sau sửa | 6 PASS |
| Hồi quy form reset và form chờ JavaScript | 108/108 PASS |
| Nhóm ngôn ngữ sau chỉnh locator test | 82/82 PASS |
| Tổng ca trình duyệt khác nhau đã đạt | **190/190**, 95 ca × 2 engine |
| Unit tập trung | 25/25 PASS |
| Unit toàn dự án | **4.745 PASS**, 1 bỏ qua |
| Build fixture Webpack + build ứng dụng Turbopack | PASS |
| Typecheck chạy sau build | PASS |
| Lint toàn dự án | 0 lỗi, 41 cảnh báo |
| Lint tệp thay đổi | 0 lỗi, 0 cảnh báo |
| Rà soát hình ảnh | 40 ảnh: 16 form EN/VI, 16 notice, 8 lỗi VI ở 320px |

Số 190 được ghép từ 108 ca `form.spec.ts`/`readiness.spec.ts` đạt trong lần
chạy toàn fixture và 82 ca `language.spec.ts` đạt trong lần chạy tập trung cuối.
Không cộng các ca chạy lặp. Cả hai lần đều đặt retries=0; không có ca bỏ qua
hay flaky. Lần chạy toàn fixture ban đầu có 188 PASS/2 FAIL: locator nhãn
mật khẩu chủ salon dùng tên chính xác nhưng hướng dẫn độ mạnh cũng tham gia
tên truy cập sau khi nhập. DOM xác nhận bản dịch và dữ liệu đúng. Đã sửa test
để kiểm tra riêng nhãn chính và ô nhập bên trong, rồi chạy lại toàn nhóm ngôn
ngữ. Giữ nguyên log, trace và ảnh của lần thất bại.

Một unit cũ ban đầu lỗi do mock che luôn phần thông báo vừa được chuyển sang
component client. Đã kiểm tra cờ reauthentication từ trang server bằng unit
và nội dung thực của thông báo bằng browser. Không giảm điều kiện bảo vệ để
làm test đạt. Các cảnh báo build/Vite và 41 cảnh báo lint được lưu trong log;
không coi cảnh báo là số lỗi đã sửa.

Các ca ngôn ngữ kiểm tra nội dung từ HTML trước JavaScript đến sau hydration,
cookie/localStorage khác nhau, đổi ngôn ngữ khi có nội dung nhập/lỗi và khi
login đang chờ phản hồi. Kiểm tra các trạng thái đăng nhập lại, đổi mật khẩu
thành công, link hết hạn và khôi phục tạm thời không khả dụng. Lỗi đăng nhập
vẫn chung cho thông tin sai và tài khoản không có vai trò; thông báo gửi link
không tiết lộ tài khoản có tồn tại hay không. Đổi ngôn ngữ không tự gửi lại.

Rà soát ảnh không thấy tràn ngang, chồng chữ hoặc lỗi dấu trong mẫu đã kiểm
tra. Nút gửi cao ít nhất 44px tại 320px, màu lỗi khớp viền input. Màu tiêu đề,
hướng dẫn và nút không đổi khi chuyển EN/VI. Ảnh Chromium và WebKit có khác
biệt hover/focus của thiết bị; không dùng khác biệt đó để kết luận lỗi màu.
Rà soát React: dùng provider sẵn có, thông báo suy ra từ trạng thái, không
thêm effect/hook khắc phục hydration hoặc dependency/primitive mới.

## Giới hạn và an toàn

Đây là bằng chứng component cục bộ. Fixture chỉ chứa đúng 7 action stub có
chủ đích; browser chặn mọi mutation và điểm đến ngoài loopback. Không sao chép
credentials, khởi động database, gửi email/SMS, tạo tài khoản/booking, gọi nhà
cung cấp hoặc thay dữ liệu hai salon đang live.

**NOT_RUN:** CI/Preview/Production của bản vá mới. **NOT_PROVEN trong lô này:**
Auth thật, inbox nhận email, toàn bộ vòng đời reset trên bản triển khai mới,
MFA và shell đã đăng nhập, mọi theme/role/flow, autofill của trình quản lý mật
khẩu, 784/784 chức năng. Tiêu đề tab browser vẫn dùng metadata EN như trước;
phạm vi sửa là nội dung bên trong trang. Câu nhắc quên mật khẩu chủ salon có
unit EN/VI; không thêm đường gửi email thật vào fixture này.

Các mục TryOn, `activity-unread` 403 và Square saved-card vẫn được giữ riêng,
không được coi là đã xử lý bởi lô ngôn ngữ.

## Bằng chứng và bước phát hành

Artifact: `/Users/huytran/nailiq-audit-results-20260907/auth-language/`.
Các tệp chính: `baseline-results.json`, `baseline-artifacts/`,
`fixed-six-results.json`, `expanded-browser-results.json`,
`expanded-initial-artifacts/`, `final-language-results.json`,
`final-language-artifacts/`, `FINAL_COUNTS.json`, `visual-manifest.json`,
`visual-sheet-1.png` đến `visual-sheet-5.png`, các log unit/build/lint/typecheck,
`source-manifest.json` và `review.patch`.

Bản sửa đã sẵn sàng để duyệt riêng việc commit, push nhánh
`fix/auth-language-20260910` và mở draft PR chạy CI/Preview. Việc đó không
bao gồm merge hoặc triển khai Production.
