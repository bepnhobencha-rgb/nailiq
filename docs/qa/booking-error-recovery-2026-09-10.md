# Booking error recovery — 2026-09-10

**PASS_LOCAL. Chưa commit, push, CI/Preview hoặc phát hành.**

Mục 145 trong danh sách 784: error boundary của booking flow. Phạm vi ưu tiên P1
trong Master Plan: khách đọc được thông báo trên iPhone và không được hướng dẫn
sai về kết quả đặt lịch. Base chính thức: a4479afeafc7453b4dd85c3f1bbad758389a711b.
Nhánh: fix/booking-error-recovery-20260910.

## Lỗi đã tái hiện

Dùng component thật trên fixture local, chọn Tiếng Việt/Light rồi bấm
“Simulate confirmation then render failure”. Bộ đếm xác nhận giả lập là 1,
nhưng fallback vẫn nói “Your selection was not confirmed.” bằng tiếng Anh.
Boundary chỉ nhận render error, không có bằng chứng kết quả ghi booking để đưa
ra khẳng định đó. Không coi counter giả lập là một booking đã commit ở database.
Chưa xác định tần suất lỗi render thực tế hay khách nào bị ảnh hưởng trên Production.

Ảnh chụp còn cho thấy chữ trắng chìm trên nền sáng: contrast tiêu đề 1.09:1,
nội dung 2.35:1. Nguyên nhân là dùng màu global thay vì booking theme variables.
Đã tải lại build trước/sau; lỗi không liên quan ngày/giờ tiệm hoặc dữ liệu khách.

## Bản sửa

- Copy Anh/Việt được truyền từ cùng t.errorBoundary vào public và embed routes.
- Thông báo lỗi hiển thị không khẳng định booking thất bại hay thành công; nếu vừa
  gửi yêu cầu, người dùng được nhắc kiểm tra xác nhận hoặc liên hệ tiệm trước khi đặt lại.
- Card, chữ và nút dùng palette booking đang có; không thêm màu hoặc primitive.
- Nút “Tải lại biểu mẫu đặt lịch” giữ reset boundary; không thêm submit, server
  action, Auth, schema, provider hay thay đổi chính sách booking.
- ErrorReporter và thông tin chẩn đoán của sản phẩm được giữ nguyên.

## Kiểm chứng

- Hai ca RED trên base ở Chromium/WebKit, Vietnamese/light/320px. Lượt đầu mắc
  strict locator vì Next có route-announcer role=alert; đã giữ lại log và sửa
  selector chỉ trong main. Lượt RED sau đó chứng minh lỗi copy/contrast thật.
- 16/16 browser PASS, 0 SKIP/flaky/retry. Lỗi trước xác nhận, sau xác nhận giả lập,
  lỗi dai dẳng, keyboard/pointer retry; không có mutation hoặc outbound request.
- Contrast nhỏ nhất trong 16 ca: tiêu đề 15.08:1, nội dung 5.71:1; nút >= 44px;
  không tràn ngang. Xem trực tiếp in-app browser ở 320px, tiếng Việt, sáng và tối.
- 6/6 unit về ngôn ngữ/link + 5/5 standalone booking palette PASS.
- Build fixture và build toàn ứng dụng bằng webpack PASS; typecheck PASS;
  lint các file liên quan 0 lỗi/0 cảnh báo; git diff --check PASS.
- Kiểm tra i18n toàn cục: 0 lỗi, 13 cảnh báo sẵn có; kiểm tra đó chỉ quét hai
  bundle hiện hữu, còn copy booking mới được kiểm chứng bằng typecheck và browser.
- Đã thêm CI job cho fixture; chưa chạy GitHub CI trên bản sửa này.

## Rà soát lần hai và giới hạn

PASS cho boundary copy, theme, reset và wiring public/embed đã kiểm tra. Không
thay đổi nhánh xử lý khi children đang hoạt động bình thường. Quyền/booking writes
không thay đổi. Không dùng suppressHydrationWarning hoặc nới test để che lỗi.

Đây là bằng chứng component local cho mục 145, không phải chứng nhận 100% chức
năng hoặc toàn bộ 784 mục. Chưa test crash có booking thật, lưu giữ lựa chọn sau
remount, thiết bị iPhone thật hoặc deployment chứa sửa đổi. Hai salon live không
bị ghi dữ liệu hay đổi cấu hình. Dependencies dùng lại đúng lockfile của base.

Artifacts: /Users/huytran/nailiq-audit-results-20260907/booking-error-recovery/
(before-verified.json/log, after.json/log, ảnh before/after, build/typecheck/lint/
unit/theme-unit/i18n logs). Các lần thất bại được giữ nguyên.
