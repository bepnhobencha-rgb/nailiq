# QA — cảnh báo mất kết nối trên mobile và ngày tiếng Việt

Phạm vi: local từ main `2909db45`, nhánh `fix/coco-mobile-status-overlap-20260908`. Owner QA đăng nhập thật trên database loopback dùng riêng; chặn SMS/email/calls, không có credential provider. Không thao tác salon live. Kết quả này cập nhật QA-CB-02 trong báo cáo connection-banner cùng ngày.

## Lỗi đã tái hiện và sửa local

1. **Coco che Updated — mức trung bình.** Đặt nhãn Updated ở vùng dưới viewport iPhone; `elementFromPoint` trúng nút Coco. Test hồi quy FAIL trên build gốc. Coco được đặt trong luồng bố cục phía đầu nội dung lễ tân ở viewport dưới `xl`; desktop giữ vị trí nổi. Điều kiện feature/role và trạng thái chat giữ nguyên. Nút dùng màu token cũ, cao 44 px; mở/đóng được mà không gửi câu hỏi.
2. **Create che Updated trên iPhone SE — mức trung bình.** Sau khi dời Coco, kiểm tra 320×568 vẫn thấy Create che nhãn. Dời đúng một menu Create vào đầu lịch mobile, trước điều hướng ngày; menu mở xuống dưới. Không đổi handler hoặc quyền tạo lịch. Các lựa chọn Create vẫn được kiểm tra qua bộ shell V2.
3. **Ngày tiếng Việt gây React #418 — mức cao.** Tái hiện cả trên build gốc và dev gốc. Stack chỉ ra `ViewedDateChip.tsx`: server render `8 tháng 9, 2026`, WebKit render `ngày 8 tháng 9, 2026`. Ghép nhãn từ các phần day/month/year của `Intl.formatToParts`, bỏ sự phụ thuộc vào literal khác nhau giữa runtime. Không dùng suppressHydrationWarning.

## Bằng chứng kiểm tra

- Hồi quy cuối: 4 ca Anh/Việt × Chromium/WebKit, lặp 3 lần = **12/12 PASS**, 0 skip/flaky/retry. Mobile kiểm tra cả kích thước mặc định và 320×568; bắt buộc Updated không bị che, Reload đăng ký lại Realtime thật, Coco mở/đóng và không có hydration error.
- Ma trận ảnh/đo bố cục: iPhone SE EN, iPhone Pro Max VI, iPad VI, desktop EN: **4/4 PASS trong phạm vi bố cục, hydration và không gửi request AI**. Đã xem ảnh cảnh báo và vị trí Coco; màu nút giữ nguyên `rgb(212,175,55)` với chữ `rgb(11,12,16)` từ token hiện có.
- Bộ shell V2 liên quan: **8/8 PASS** sau sửa cuối, gồm desktop/iPad/mobile và menu chọn lịch.
- Guided Setup: **4/4 PASS**, kiểm tra luồng bật/tắt điều hướng có liên quan.
- Unit liên quan: **18/18 PASS**. Build, typecheck, lint, diff check PASS.

## Giới hạn và lỗi chưa đủ bằng chứng

Các lượt WebKit mở rộng vẫn ghi nhận `TypeError: Load failed` và thông báo `due to access control checks` quanh URL chuyển trang. Dấu hiệu cũng có trên bản gốc; chưa xác định nguyên nhân và không kết luận CORS/backend. Toàn bộ thông báo giữ trong JSON/trace. Diagnostic chỉ nghiệm thu bố cục và lỗi hydration đã xác định, không tuyên bố console sạch toàn bộ. Lượt đầu chọn `textarea` quá rộng, và lần chạy cấu hình ma trận đầu sai đường dẫn globalSetup, là lỗi bộ kiểm tra đã được sửa và lưu log.

Chưa có CI/Preview/Production cho bản sửa này. 16 ca skip còn lại trên main không thuộc phạm vi sửa. Số lượt test không tương đương số chức năng trong danh sách 784.

Bằng chứng local: `/Users/huytran/nailiq-audit-results-20260907/coco-mobile-status/` (JSON, trace, ảnh, log build/kiểm tra và biên bản dọn database).
