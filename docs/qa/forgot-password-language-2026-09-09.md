# NailIQ — đồng bộ ngôn ngữ trang Quên mật khẩu

Ngày 2026-09-09. **PASS_LOCAL**, chưa commit/push hoặc chạy CI/Preview/Production cho bản vá này.

Nhánh `fix/forgot-password-language-20260909`, nền main `812445ba4b2e7beb4f26024a727cf42ab7e4afe0` (PR #1366 đã phát hành). Tiếp tục mục còn ghi nhận của luồng Auth/email trong Master Plan giai đoạn 1 và yêu cầu kiểm tra tính đồng bộ form.

## Lỗi, nguyên nhân và thay đổi

Lỗi mức thấp: chọn tiếng Việt rồi mở `/login/forgot-password`; form tiếng Việt nhưng tiêu đề và hướng dẫn tiếng Anh. Tái hiện trên build local trước sửa bằng Chromium/WebKit: 2/2 ca FAIL đúng tại tiêu đề; snapshot và ảnh browser xác nhận trộn ngôn ngữ.

Header nằm trong Server Component với chuỗi EN cố định; form dùng `useUserLanguage`. Chuyển đúng markup header sang export `ForgotPasswordHeader` trong module client hiện có để đọc cùng context và các khóa dịch có sẵn. Cập nhật hai bản dịch hướng dẫn để giữ nội dung điều kiện của bản EN hiện hành: gửi link nếu email khớp tài khoản chủ salon.

Không thay CSS, màu, khoảng cách, primitive, metadata, Server Action, xử lý lỗi/retry, schema, provider, cookie hoặc chính sách ngôn ngữ. Hai khóa hướng dẫn chỉ được dùng tại header này. Tiêu đề tab browser vẫn là metadata EN như trước; phạm vi bản vá là nội dung hiển thị trong trang.

## Bằng chứng

| Kiểm tra | Kết quả |
| --- | --- |
| Trước sửa: tiêu đề VI × Chromium/WebKit | 2 FAIL, lỗi được tái hiện |
| 16 ca hồi quy hiện có: EN/VI × Chromium/WebKit × 429/503/abort/typed error | 16 PASS, 0 skip/retry/flaky/runner error |
| Assertion bổ sung trong các ca trên | Header và hướng dẫn đúng ngôn ngữ trước submit và sau xác nhận; vẫn giữ email, sửa lỗi và retry chủ động |
| Kiểm tra render ngoài repo: 4 cấu hình ngôn ngữ/notice × 2 browser | 8 PASS |
| 19 unit hiện có về password-reset UI/actions/recovery security/capability | 19 PASS, 0 skip/fail |
| Production build Webpack, typecheck chạy sau build, lint các file sửa, diff check | PASS |

8 ca render gồm EN mặc định; cookie VI kèm notice hết hạn; localStorage VI kèm notice tạm thời không khả dụng; localStorage EN ghi đè cookie VI. Kiểm tra HTML server ban đầu và trạng thái sau hydration, heading/hướng dẫn/nút/notice, không pageerror, không tự POST, không tràn ngang, header không chồng form, nút cao tối thiểu 44px. Chromium rộng 320px và WebKit iPhone 13; màu computed của heading/hướng dẫn/nút đồng nhất giữa các trạng thái ngôn ngữ.

Đã xem ảnh trước/sau VI desktop, VI 320px có notice hết hạn, VI iPhone có notice tạm thời không khả dụng. Không thấy chồng lấn hoặc lỗi dấu tiếng Việt. Rà soát React: dùng provider hiện có, không thêm effect/state/listener, không thêm primitive hay dependency, không thay handler form. Không tăng số ca trong bộ E2E CI; chỉ bổ sung assertion vào 16 ca đã có.

## An toàn và giới hạn

Chỉ chạy local, cấu hình loopback của database dùng một lần đang dừng, chặn toàn bộ browser write trong Playwright; không gửi email/SMS/call, tạo booking/account hoặc thay dữ liệu khách thật. Không khởi động database. Không chạy lại full unit suite hoặc toàn bộ E2E trong lô sửa nội dung này; số PASS cũ của main không được tính lại vào đây.

CI/Preview/Production của bản vá mới: **NOT_RUN**. Email đến inbox, hoàn tất đổi mật khẩu thật, metadata đa ngôn ngữ, toàn bộ theme/flow/role và 784/784 chức năng: **NOT_PROVEN trong lô này**.

Bằng chứng ngoài repo: `/Users/huytran/nailiq-audit-results-20260907/forgot-password-language/` — `browser-before.json`, `browser-after.json`, `browser-summary.json`, `render-check.json`, `unit.json`, build/typecheck/lint logs và ảnh. Dữ liệu FAIL trước sửa được giữ riêng.
