# SuperAdmin password reset response recovery — 2026-09-09

**PASS_LOCAL — chưa commit/push, CI, Preview hoặc Production cho đợt này.**

Base: `f19c71adf76361d52d3116429b0be0e9fc8cf5fa` (PR #1368 đã phát hành).
Nhánh: `fix/superadmin-reset-response-recovery-20260909`.

## Lỗi và bản sửa

SuperAdmin nhập hai mật khẩu hợp lệ rồi gửi. Khi phản hồi Server Action mất kết nối hoặc trả HTTP 429/503, promise bị reject ngoài xử lý lỗi; Next chuyển sang error boundary, làm mất form và nội dung đã nhập. Tái hiện trên build mới từ base: **6/6 ca phát hiện lỗi**, 3 loại lỗi × Chrome desktop/WebKit iPhone 13. Đây là kiểm tra component runtime trong fixture độc lập, không phải phiên khôi phục Production.

Bản sửa bắt lỗi tại lần chờ phản hồi action, giữ hai ô nhập, hiển thị hướng dẫn song ngữ về kết quả chưa thể xác nhận và liên kết `/superadmin/login`. Không tự gửi lại, không gắn `reset=ok` nếu chưa nhận `{ok:true}`. Các mã lỗi server và nhánh thành công giữ nguyên. Điều hướng nằm ngoài catch.

Chỉ một component Production thay đổi. Không sửa Server Action, chốt phiên khôi phục, kiểm tra vai trò, chính sách mật khẩu, database, migration, provider hoặc cấu hình triển khai.

## Kết quả

| Kiểm tra | Kết quả |
| --- | --- |
| Trước sửa: abort/429/503 × 2 browser | 6 lỗi mất form được tái hiện |
| SuperAdmin song ngữ × 2 browser sau sửa | 20/20 PASS |
| Owner EN/VI × 2 browser hồi quy | 40/40 PASS |
| Tổng browser fixture | 60 PASS; 0 FAIL, SKIP, flaky, retry |
| Unit auth/recovery/SuperAdmin guards/UI | 32/32 PASS, 6 file |
| Next production build với cấu hình local cô lập | PASS |
| TypeScript sau build | PASS |
| ESLint file sửa/fixture | 0 lỗi, 0 cảnh báo |
| ESLint toàn repo | 0 lỗi, 42 cảnh báo trùng đợt đã nghiệm thu trước |
| Git diff whitespace | PASS |
| Cô lập action giả khỏi build chính | PASS |

20 ca SuperAdmin gồm 7 phản hồi lỗi × 2 browser, validation × 2, quay lại đăng nhập không báo thành công × 2, chống gửi lặp khi pending × 2. Kiểm tra giữ mật khẩu, xóa lỗi khi sửa ô nhập, retry tường minh, điều hướng đúng khi được xác nhận, không lộ lỗi kỹ thuật, không pageerror/tràn ngang, màu viền khớp thông báo và liên kết cao ít nhất 44px. Đã xem ảnh WebKit iPhone: chữ song ngữ đầy đủ, không che/tràn form.

Ứng dụng Next fixture mount component thật và dùng bộ giải mã Server Action thật. Action fixture chỉ ném lỗi nếu request lọt qua chặn; mọi POST được giả lập, mọi request ngoài loopback bị chặn. Manifest chỉ cho phép đúng hai action trơ. Build chính vẫn trỏ `shared/superadmin/superadminAuth.ts` và không chứa sentinel action giả. Không gửi email/SMS, đổi mật khẩu thật hay thao tác dữ liệu salon live.

## Giới hạn và bước tiếp

- Đây là 60 **ca kiểm thử**, không phải 60 chức năng hay bằng chứng đạt 784/784.
- Luồng đầy đủ qua email khôi phục thật, phiên hosted và đổi mật khẩu thật: **NOT_PROVEN**.
- CI/Preview/Production của đợt SuperAdmin: **NOT_RUN**. PR #1368 là đợt owner trước, không gộp trạng thái phát hành vào đợt này.
- Lỗi câu footer tiếng Việt trang quên mật khẩu đã ghi riêng ở đợt trước, chưa sửa trong phạm vi này.
- Bước đề nghị: commit đúng 8 file, push nhánh riêng và mở PR chạy CI/Preview; chưa merge/deploy.

Bằng chứng: `/Users/huytran/nailiq-audit-results-20260907/superadmin-reset-response-recovery/` gồm browser-before/after.json, ảnh trước/sau, unit.json, build.log, typecheck.log, lint.json, lint-full.json và fixture-isolation.json.
