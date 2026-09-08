# Loyalty Dashboard — phục hồi khi tải lỗi

Ngày kiểm tra: 2026-09-08, America/Vancouver. Trạng thái: **LOCAL PASS, chưa phát hành**.

Nhánh: `fix/loyalty-widget-load-recovery-20260908`.
Base: `3d4ba8f0cee65bee9dd0a1601fcf4043d1f7c25f` (PR #1358).
Phạm vi: độ ổn định Dashboard của Owner, thuộc giai đoạn ổn định trong Master Plan.

## Lỗi đã xác nhận — mức trung bình

Widget gọi `getLoyaltyProgram` và `getLoyaltyStats` qua `Promise.all` nhưng chỉ xử lý thành công. Khi một request bị từ chối, widget không hiển thị, không có nút thử lại và phát sinh unhandled rejection. Lỗi vẫn xuất hiện nếu request trả lỗi sau khi Owner đã chuyển sang trang Clients.

Trace WebKit từ đợt kiểm tra Coco trước đó ghi nhận request POST Dashboard bị hủy khi hard navigation. `next-action` của request ánh xạ tới `getLoyaltyProgram` trong manifest của đúng build. Đây là căn cứ điều tra; bộ test lỗi mạng có kiểm soát bên dưới xác nhận đường gây unhandled rejection.

Bước tái hiện:

1. Đăng nhập bằng tài khoản Owner thật trong Auth của database QA riêng, demo tắt.
2. Mở Dashboard của salon QA đã có lịch hẹn. Salon trống chỉ hiện màn hình chia sẻ booking, không chứa widget này.
3. Cho đúng request đọc chương trình hoặc thống kê Loyalty từ chối với lỗi mạng.
4. Kiểm tra thông báo, thử lại hai lần; lần cuối trả về phản hồi server thật.
5. Với ca vòng đời, giữ request, chuyển sang Clients bằng liên kết trong ứng dụng, rồi mới cho request từ chối.

Đối chiếu mã gốc: **10/10 ca thất bại**, tất cả probe xác nhận request mục tiêu được gọi và ghi nhận `TypeError: QA loyalty read interrupted`. Không có retry tự động của test.

## Thay đổi

- Xử lý cả kết quả thành công và thất bại của hai lượt đọc; bỏ cập nhật trạng thái sau khi component unmount hoặc đổi slug.
- Hiển thị lỗi riêng bằng Việt/Anh và nút thử lại theo ngôn ngữ Dashboard. Không biến lỗi tải thành kết luận "chưa có chương trình".
- Giữ thông báo trong khi thử lại, hiển thị trạng thái đang tải và khóa nút để tránh bấm lặp.
- Dùng Button và màu token hiện có. Chừa khoảng trống ở màn hình nhỏ để thông báo và nút không bị Coco/thanh điều hướng che.
- Thêm regression vào shard CI dùng Auth thật và tắt demo; đã chạy trên CI của PR #1359; kết quả và phần sửa harness bổ sung ghi ở cuối báo cáo.

Không đổi server action, schema, quyền, feature flag hoặc đường ghi giá trị Loyalty. Không thay đổi nội dung của widget khi tải thành công.

## Kiểm chứng

| Gate | Kết quả local |
| --- | --- |
| Chrome + WebKit: từng lượt đọc lỗi, Việt/Anh, thử lại tiếp tục lỗi rồi phục hồi | 8 PASS |
| Chrome + WebKit: lỗi đến sau khi chuyển sang Clients | 2 PASS |
| Receptionist Center: ngắt kết nối, Reload, thời điểm cập nhật, Việt/Anh × hai trình duyệt | 4 PASS |
| Unit: khóa ghi giá trị Loyalty/gift, cổng bật Loyalty, định dạng Dashboard | 8 PASS / 3 file |
| Production build, typecheck, lint file thay đổi, diff whitespace | PASS |

Lượt tổng hợp: **14 PASS, 0 skip, 0 fail, 0 flaky, không retry**, lúc 13:44–13:45 PDT. Sau khi sửa script ngôn ngữ của test để không truy cập localStorage trên `about:blank` lúc teardown, chạy lại 10 ca Loyalty: **10 PASS, không retry, 0 page error trong cả 10 trace**, lúc 13:46 PDT. Đây là cùng 10 kịch bản, không cộng thành 24 chức năng.

Ảnh fallback Việt/Anh đã được xem trực tiếp. Có kiểm tra màn hình WebKit rộng 320 px, vùng bấm cao tối thiểu 44 px, nút nằm trong chiều ngang viewport, các điểm trên thông báo không bị lớp nổi che. Nút thực tế cao 48 px.

Hai sai lệch của harness đã được loại trừ trước nghiệm thu: seed salon trống không mount widget; Clients trống không có danh sách nhưng vẫn có ô tìm kiếm. Kết quả đỏ do hai sai lệch này không dùng làm bằng chứng lỗi sản phẩm.

## An toàn và giới hạn

- Toàn bộ kiểm tra dùng database Supabase loopback dùng một lần; thông báo outbound bị tắt, không có cấu hình provider thật. Không test trên hai salon live.
- Cleanup sau cùng xác nhận 0 salon, 0 booking, 0 Auth user, 0 payment operation, 0 loyalty card và 0 stamp event trong database QA.
- Phản hồi thật sau retry thuộc cấu hình Loyalty mặc định tắt/không có chương trình. Chưa chứng minh hoạt động tích điểm, đổi quà hoặc toàn bộ chương trình Loyalty đã bật bằng bộ test này.
- Trace Receptionist Center WebKit vẫn ghi nhận thông báo access-control trong lúc hard navigation hủy request, gồm POST action và RSC prefetch; không còn unhandled rejection của Loyalty trong các trace đó. Không kết luận mọi cảnh báo mạng/CORS đã được sửa hoặc suy ra cấu hình CORS Production sai.
- PR #1359: CI/Preview của bản đầu `ffe6f560` đã chạy; bản cập nhật harness bên dưới cần CI xác nhận lại. **Chưa merge hoặc phát hành Production**. Bằng chứng này không chứng minh đủ 784 chức năng hoặc mọi tình huống của tất cả vai trò.

## Bằng chứng

Thư mục local: `/Users/huytran/nailiq-audit-results-20260907/loyalty-widget-recovery/`.

- `baseline-valid.json`, `baseline-valid-results/`: 10 ca đối chiếu mã gốc.
- `before-after-probes.json`: probe trước/sau và các lượt chỉnh harness.
- `final.json`, `final-results/`: 14 ca tổng hợp và ảnh.
- `acceptance.json`, `acceptance-results/`, `acceptance-page-errors.json`: nghiệm thu 10 ca Loyalty với harness cuối.
- `build-final.log`, `typecheck-final.log`, `lint-final.log`, `unit.log`.
- `cleanup-counts.json`, `cleanup-sweep.log`, `manifest.json`.

Trace và dữ liệu xác thực QA chỉ nằm trong thư mục bằng chứng local, không đưa vào Git.

## Bổ sung sau lượt CI đầu tiên của PR #1359

Commit `ffe6f560`: CI `34277343716` và E2E `34277343713` đều kết thúc success. Bộ E2E chính đạt **458 ca, 16 skip, 0 fail, 0 flaky, không retry**. So với PR trước chỉ thêm 10 kịch bản Loyalty; không đổi kết quả của các ca cũ. Cả 10 probe Loyalty đều ghi nhận đúng số lượt gọi và không có lỗi trình duyệt. Unit 4.524 pass/1 skip; Smoke 8 pass; Visual 16 pass. Sáu job QA xác nhận cleanup và hủy database thành công. Preview READY, `/api/version` khớp commit.

Lượt WebKit bổ sung có **1 ca `ops_admin` phải retry rồi mới đạt**, ngoài 458 ca chính. Assertion quyền và HTTP đều qua; assertion mảng browser errors thất bại vì hai cảnh báo RSC prefetch của `/superadmin/support` và `/superadmin/settings`.

Trace chỉ ra race của harness: dashboard URL được nhận lúc 16.393 giây; `waitForLoadState("networkidle")` trả về ngay lúc 16.396 vì event đã xảy ra trên document trước; `page.goto("/superadmin/dashboard")` tiếp theo bắt đầu lúc 16.397. Cảnh báo xuất hiện lúc 16.427–16.428, cùng đợt chuyển trang có request RSC bị `Load request cancelled`. Những endpoint đó sau đó trả 200. Không lấy hiện tượng này làm bằng chứng cấu hình CORS Production sai.

Đã sửa riêng `e2e/superadmin/page-role-boundary.spec.ts`: giữ trang đăng nhập mở; mỗi URL kiểm tra quyền mở ở trang mới trong cùng BrowserContext với phiên Auth thật. Vẫn kiểm tra HTTP dưới 500, quyền allow/deny, heading 404, nút thao tác và browser errors trên từng trang trước khi đóng. Trang đăng nhập cũng tiếp tục được theo dõi lỗi. Không lọc bỏ chuỗi lỗi, không sửa server/role policy, không tăng retry.

Kiểm chứng harness trên production build local có cùng mã ứng dụng:

- `ops_admin` WebKit: 5 lần liên tiếp PASS, không retry; 40 quan sát role/route đúng.
- Sáu vai trò × Chromium/WebKit: 12/12 PASS, không skip/retry; 96 quan sát role/route đúng và 0 page error trong toàn bộ trace, kể cả teardown.
- Lint, typecheck, diff check PASS. Không build lại ứng dụng vì chỉ đổi test và tài liệu.
- Cleanup: 0 salon, booking, Auth user, superadmin, payment operation, loyalty card và stamp event trong database QA.

Bằng chứng bổ sung: `publication/ci-acceptance-initial.json`, `publication/superadmin-webkit-failure-trace.zip`, `publication/superadmin-webkit-failure-events.json` và `publication/role-harness-fix/`. Lượt CI đầu có flaky vẫn được giữ nguyên; không thay thế nó bằng kết quả local.
