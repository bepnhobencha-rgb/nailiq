# Refresh cookie WebKit — ổn định đường chuyển tiếp Auth của bài test

Ngày 10/09/2026 America/Vancouver. Nhánh `fix/cookie-refresh-clock-20260910`,
base main `93e8be2aa3e8d01ef4fa7582b73adaa843c80558`.

**FIXED_LOCAL / PASS_LOCAL.** Chỉ sửa test và tài liệu này; chưa commit/push,
chưa có CI/Preview cho bản sửa mới, chưa merge/deploy Production.

## Lỗi và nguyên nhân đã tái hiện

PR #1394, E2E run `34546601321`, attempt 1, job `103100561115` ghi nhận
`auth-cookie-security.spec.ts:140` trên mobile timeout khi chờ response refresh
45 giây. Retry tự động đạt; không coi đó là một lượt đạt sạch.

Trên main chưa sửa, 6 lượt chạy bình thường đều đạt. Khi chờ phiên ổn định
2,5 giây trước khi đổi giờ, test thất bại. Một lần tái hiện tiếp theo chờ trực
tiếp `navigator.serviceWorker.controller` để xác nhận điều kiện:

- `/nailiq-sw.js` nhận điều khiển trang trước khi test tăng đồng hồ 16 phút.
- Timer SDK vẫn chạy sau 30.002 ms; tab vẫn visible. Có yêu cầu refresh thật.
- Cả 7 lần gửi lại đều gặp lỗi TLS; đoạn `context.route` chuyển tiếp Auth
  không được gọi lần nào.
- WebKit nâng URL Auth local từ HTTP lên HTTPS theo CSP. GoTrue dùng một lần
  chỉ có HTTP; khi request không qua đoạn chuyển tiếp, kết nối TLS thất bại.

Service worker của ứng dụng không cache Auth POST: code bỏ qua non-GET và
cross-origin. Vấn đề được tái hiện là request trên trang do worker điều khiển
bỏ qua cơ chế interception của Playwright/WebKit trong môi trường HTTPS local.
[Playwright mô tả giới hạn routing với service worker](https://playwright.dev/docs/api/class-browsercontext#browser-context-route).

Đối chứng: chỉ chặn service worker trong context thử, giữ thời gian chờ và
Auth thật, thì request được chuyển tiếp, GoTrue trả 200 và cookie đạt yêu cầu.
Đã thấy nhịp timer 30 giây thật; không sửa đồng hồ theo giả thuyết ban đầu.

Lần CI cũ không có trace/request/controller snapshot. Tái hiện này chứng minh
cơ chế gây cùng signature, không khẳng định mọi chi tiết của lần CI lịch sử.

## Bản sửa

Tạo fixture `routedRefreshTest` với `serviceWorkers: "block"`, chỉ áp dụng cho
test tự refresh. Bảy test cookie khác tiếp tục dùng fixture ban đầu. Không đổi
cookie policy, app/PWA, schema, quyền, provider, timeout, retry hay assertions.
Refresh vẫn đi qua browser SDK và GoTrue thật trong database local mới.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| Main chưa sửa, chạy bình thường trên WebKit | 6/6 PASS; chưa tái hiện ở điều kiện này |
| Main với chờ ổn định/chờ worker nhận điều khiển | 3 lượt FAIL cùng timeout/TLS, giữ bằng chứng |
| Đối chứng chặn worker, chờ ổn định, WebKit | 2/2 PASS, refresh thật sau 30 giây |
| File test đã sửa, cả Chromium và WebKit | 16/16 PASS, không skipped/flaky/retry |
| Bản sửa + chờ ổn định, lặp 3 lần mỗi trình duyệt | 6/6 PASS, không retry; mỗi lượt có tick thật khoảng 30 giây, Auth 200, cookie hợp lệ |
| TypeScript, lint file đổi, diff check | PASS |
| Build ứng dụng Webpack/Node 20 | PASS trước sửa test; source ứng dụng giữ nguyên |
| Schema parity local | PASS theo contract trong repo; không phải kiểm chứng Production hiện tại |

16 lượt gồm login/proxy refresh của owner, admin, senior, receptionist,
nail_tech; PKCE trước handoff Google ở EN/VI; tự refresh trên cả hai trình duyệt.
Google được chặn trước provider: đây không phải bằng chứng đăng nhập Google thật.
Đợt tái hiện đầu dừng sau lỗi thứ nhất nên có 2 lượt không chạy; không tính là
2 chức năng bị thiếu hoặc 2 test đã đạt.

## Dữ liệu và giới hạn

Next production build 16.3.4, Playwright 1.59.1 trên macOS, HTTPS
`https://localhost:3443`, app 3138, Auth 55521, Postgres 55522, mail catcher 55524.
Demo tắt; chỉ có user/salon giả, không dùng hosted keys hoặc gọi provider thật.
Không ghi token/session vào bản ghi chẩn đoán; trace/video/screenshot bảo mật
tiếp tục tắt. Không chứng nhận UI/màu sắc, mọi flow hoặc 784 chức năng.

Sau sweep: 0 salon, 0 booking, 0 client profile, 0 auth user. Đã hủy toàn bộ
container/volume của `nailiq-cookie-refresh-20260910`, đóng 5 cổng thử và giữ
nguyên 3 volume không liên quan. Chưa thay đổi dữ liệu hai salon đang live.

Artifact: `/Users/huytran/nailiq-audit-results-20260907/cookie-refresh-clock/`.
`verification.json`, `sw-controlled`, `fixed-cookie-suite`, `fixed-settled`,
`cleanup-verified.json` giữ kết quả và mốc thời gian. Không đưa toàn bộ private
log hoặc khóa tạm vào PR. PR #1394 được giữ riêng, không sửa hay merge.

Bước tiếp theo: commit/push riêng hai file đã kiểm chứng và mở PR chạy
CI/Preview sau khi được duyệt. Local PASS chưa phải CI/Production PASS.
