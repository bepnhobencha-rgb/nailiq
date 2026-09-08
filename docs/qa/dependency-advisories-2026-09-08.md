# Vá dependency sau Security Audit của PR #1359

Ngày kiểm tra: 2026-09-08. Base: `c66f22ccc2ceb288e2cbad6462489b17ff5a8c34`.
Nhánh local: `fix/dependency-advisories-20260908`.

## Lỗi đã xác nhận

`npm audit --package-lock-only --audit-level=high` thất bại trên main trong
[Security Audit job 102250247752](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/34282185801/job/102250247752).
Audit local trên lockfile nguyên gốc tái hiện cùng 1 critical và 2 moderate.
Lockfile không thay đổi trong PR #1359; bản rollback trước đó cũng dùng Next 16.3.1.
PR audit lúc 21:25 UTC trả 0 lỗ hổng; main audit lúc 21:47 UTC trả các advisory dưới đây.
Hai kết quả được giữ nguyên; không suy diễn thời điểm npm cập nhật cơ sở dữ liệu.

- [GHSA-p293-qw3h-jr36, Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36): critical, Next 16.3.1 nằm trong khoảng bị ảnh hưởng; bản vá từ 16.3.3. Nhà phát hành mô tả điều kiện máy chủ dùng filesystem Windows. Chưa có bằng chứng khai thác hoặc sự cố salon trong đợt kiểm tra này.
- [GHSA-82fw-gwwq-j7x9, Vitest](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9): lỗi đọc file của mocker trong máy chủ phát triển; sửa từ 4.1.11. Repo dùng Vitest trong môi trường test Node; không coi đây là bằng chứng lỗi runtime Production.

Audit trước xuất bản tiếp tục phát hiện 2 high trên bản vá local ban đầu:

- [Sharp GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c): cập nhật Sharp 0.35.4 để nhận bản vá libheif khi xử lý ảnh không tin cậy. Không thực hiện thử khai thác trên Production.
- [js-yaml GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh): cập nhật dependency gián tiếp của ESLint lên 4.3.2 để sửa giới hạn xử lý merge key.

Bằng chứng các lần audit được giữ riêng, không thay kết quả cũ bằng kết quả mới.

## Thay đổi

- `next` và `eslint-config-next`: 16.3.1 → 16.3.4.
- Mức tối thiểu `vitest`: ^4.1.9 → ^4.1.11; lock giải quyết Vitest/mocker 4.1.11.
- `sharp`: 0.35.3 → 0.35.4, dùng chung bản đã vá cho Next và xử lý ảnh của ứng dụng.
- `js-yaml` gián tiếp: 4.3.1 → 4.3.2.
- Lockfile được npm tạo lại; dependency gián tiếp liên quan được giải quyết lại, gồm Vite 8.2.2/Rolldown 1.2.7. Không dùng `npm audit fix --force`.
- Chọn [Next 16.3.4](https://github.com/vercel/next.js/releases/tag/v16.3.4) vì đây là bản tiếp nối 16.3.3 khôi phục AVIF Image Optimization và bổ sung các bản sửa lỗi.

Không sửa code ứng dụng, schema, quyền, feature flag hoặc ngưỡng audit.

## Đồng bộ lockfile cho Vercel

Preview đầu tiên của [PR #1360](https://github.com/bepnhobencha-rgb/nailiq/pull/1360), commit `d8d3aa0d`, dừng ở `ERR_PNPM_OUTDATED_LOCKFILE`: Vercel chọn pnpm 10 từ `pnpm-lock.yaml`, còn CI dùng npm. Bốn specifier Next, Sharp, eslint-config-next và Vitest chưa khớp với manifest. Lỗi được giữ tại `publication/preview-initial-build.log`.

Đồng bộ pnpm bằng pnpm 10.34.5; giữ các phiên bản không liên quan đã được lock. Audit npm và pnpm cùng báo 0 lỗ hổng. CI thêm `Validate Vercel lockfile` bằng frozen lockfile và thêm audit pnpm ở ngưỡng high, bên cạnh audit npm hiện có. Lệnh kiểm tra đã tái hiện việc từ chối lock cũ và chấp nhận lock mới mà không sửa file.

Bản build pnpm được kiểm tra riêng trong worktree QA: cài đặt `--frozen-lockfile`, 4.524 unit PASS/1 SKIP và production build/typecheck trên Node 20.20.2. Smoke giao diện pnpm cũng 6/6 PASS trên desktop/iPhone, không pageerror/HTTP 5xx. Bằng chứng ở `publication/pnpm-*`. Hai lockfile vẫn giữ dependency graph riêng; không đồng nhất kết quả npm CI với phép chứng minh mọi flow authenticated trên graph pnpm.

## Kiểm tra local

Bản cuối gồm cả Sharp/js-yaml được chạy bằng Node 20.20.2 như CI; bằng chứng ở `local-revision-2/`.

| Gate | Kết quả |
|---|---|
| `npm ci` từ lockfile cuối | PASS |
| Audit cả dev dependency, ngưỡng low | PASS, 0 lỗ hổng |
| Xử lý ảnh/upload liên quan Sharp | 11 PASS |
| Full unit | 4.524 PASS, 1 SKIP, 0 FAIL |
| Production build + typecheck | PASS |
| Lint | PASS, 0 lỗi; 42 cảnh báo như main |
| Chromium desktop/WebKit iPhone, `/`, `/login`, `/register` | 6/6 PASS; 0 pageerror/HTTP 5xx |
| `git diff --check` | PASS |

Các kết quả Node 24/Node 20 trước khi thêm Sharp/js-yaml được giữ ở thư mục bằng chứng gốc; không coi chúng là kết quả của lockfile cuối.

Browser chỉ mở trang và chụp ảnh; không submit form, OAuth, OTP hoặc thao tác khách hàng.
Build/server local dùng giá trị Supabase giả như build CI, không có thông tin đăng nhập Production.
Cảnh báo Edge Runtime đã có trước vẫn được ghi trong build log.

## Giới hạn và bước tiếp theo

Bản vá đã được mở thành Draft PR #1360. Các kết quả local ở trên không thay thế CI/Preview trên commit cuối. Chưa merge hoặc phát hành Production bản vá dependency.
Các flow có đăng nhập, dữ liệu salon, booking và server action trên framework mới phải được chạy bằng CI với database dùng một lần trước khi phát hành. Smoke local không thay thế các flow này.
Các con số ở đây là test case, không xác nhận 784 chức năng hoàn thành.

Bằng chứng đầy đủ: `/Users/huytran/nailiq-audit-results-20260907/dependency-advisories-20260908/`.
