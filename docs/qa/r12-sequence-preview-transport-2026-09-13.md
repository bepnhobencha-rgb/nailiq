# R12 — Luồng chuỗi và transport sau commit

Phạm vi: sửa lỗi phát hiện khi nghiệm thu V1 trên Preview riêng. Không thay đổi schema, chính sách yêu cầu thẻ, Production hoặc dữ liệu salon Live.

## Bằng chứng trước sửa

Preview `50bce9a7bc85229d36a9699ef2b35d61bdfcdf93` tạo thành công booking chuỗi synthetic, đúng hai segment và không yêu cầu thẻ. UI vẫn chuyển sang khôi phục thẻ; kiểm tra lại từ trình duyệt trả về lịch đã giữ và không cần thẻ.

Source dùng HTTP tự gọi về `/api/booking/card-capability` từ sequence-create, không mang quyền xác thực deployment. Probe kiểm soát trên cùng Preview tái hiện HTTP 401 từ lớp bảo vệ deployment. Đây là bằng chứng cơ chế từ source và probe; không có trace HTTP của chính request đặt lịch ban đầu. Regression tái hiện việc phản hồi 401 làm settlement trả pending dù lịch không cần thẻ.

## Thay đổi

Hai API capability/save-card dùng chung handler server với sequence-create. Transport nội bộ chỉ nhận đúng hai đường dẫn POST và body JSON, giữ Origin và IP đã chuẩn hóa; không chuyển cookie, Authorization hoặc khóa bypass. Các kiểm tra quyền, binding, kích thước body, rate limit, trạng thái receipt và service lưu thẻ vẫn được giữ.

Booking tiếp tục commit trước xử lý thẻ. Mốc chờ của khách vẫn là 5 giây mỗi bước. Nếu kết quả chưa rõ, phản hồi tiếp tục là pending; không gọi lưu thẻ lần hai. Transport đăng ký callback `after` trước khi bắt đầu handler để chờ đúng tác vụ đang chạy, trong giới hạn thời gian của nền tảng. Callback luôn hoàn tất mà không phát lại handler hoặc ghi lỗi thô. Pending không chứng minh tác vụ đã bị hủy hoặc thẻ đã lưu.

Lỗi CI đăng ký riêng tại SHA `1470dc6ad1e4a12ba0f9b1dd4115045d40567650`: selector `main` gặp nội dung dashboard cũ còn ẩn trong lúc Setup đang tải. Test được sửa để chờ đúng URL setup, heading tên salon và trạng thái chưa Go-Live. Giữ các kiểm tra xác nhận email, đăng nhập, Owner, trial, một salon và reload; không bỏ test hoặc nới timeout.

## Trạng thái nghiệm thu

- Existing before task: ba luồng đã có receipt booking trên hosted QA; sequence còn lỗi chuyển nhầm sang khôi phục. CI cũ chỉ còn một test đăng ký đỏ trong nhóm Settings (195 PASS, 1 FAIL).
- Implemented locally: transport server dùng chung, giữ vòng đời tác vụ sau deadline và sửa selector đăng ký. Review độc lập xác nhận quyền, rate limit, binding, receipt và không phát lại provider được giữ.
- Local QA: regression transport trước sửa đã đỏ đúng lỗi. Ba regression vòng đời request cũng đỏ trước sửa và xanh sau sửa. Bản cuối đạt 137 tests trong 12 suites, lint, Webpack build và typecheck tuần tự; source không thay đổi trong lúc chạy. Selector đăng ký giữ nguyên các kiểm tra tài khoản/quyền/trial; chạy lại toàn bộ luồng Auth thuộc cổng CI.
- Preview verified: chưa có bằng chứng Preview cho runtime mới. UI của bản cũ không thay thế nghiệm thu bản này.
- Deployed / Production verified: chưa triển khai hoặc kiểm chứng Production trong R12.

Hosted R12 dùng Supabase QA disposable và dữ liệu synthetic, provider dispatch cùng SMS/email/call/charge OFF. Không dùng bằng chứng Square sandbox R11 làm bằng chứng gọi provider của R12. Hộp thoại đăng xuất native đang chặn vòng Computer Use còn lại; bốn vai trò và dọn fixture vẫn cần hoàn tất.

## Rollback và cổng phát hành

Rollback code bằng revert lô transport này về parent `1470dc6`, kiểm tra lại route contract và build trước xuất bản. Không có migration cần rollback. Giữ nguyên receipt, operation và continuation đã ghi; không xóa chúng hoặc phát lại source token. Reconciliation tiếp tục sở hữu các kết quả chưa rõ. Bản cũ có thể tái hiện lỗi HTTP self-fetch trên Preview được bảo vệ.

Không merge hoặc triển khai Production từ báo cáo này. Chỉ đóng lỗi khi CI và Computer Use trên đúng phiên bản sửa đạt, đồng thời hoàn tất quyền truy cập các vai trò và cleanup đúng manifest của lượt QA.
