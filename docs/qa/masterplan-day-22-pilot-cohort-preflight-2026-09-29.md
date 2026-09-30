# Master Plan — Ngày 22: tiền kiểm cohort pilot

Tiền kiểm ban đầu đọc **chỉ metadata/tổng số** lúc
`2026-09-30 04:06 UTC` (29/09 theo giờ Vancouver); sau đó có phụ lục ghi
thao tác xóa NailIQ-only được Huy phê duyệt riêng. Nguồn: Supabase Production
`NailIQOS`, bảng `salons`, `staff`, `services`, `bookings`; không đọc tên hoặc
liên hệ khách. Đếm lịch có `start_time_utc` trong 14 ngày trước/sau thời điểm
kiểm tra; số đếm không tự chứng minh các lịch đều hợp lệ cho pilot.

| Địa điểm | Tình trạng quan sát được | Lịch 14 ngày qua / 14 ngày tới | Kết luận tiền kiểm |
|---|---|---:|---|
| Hi-Lite Head Spa | Không lưu trữ; hồ sơ hoàn chỉnh; 10 thợ, 12 dịch vụ | 91 / 27 | Huy đã chọn cho pilot; vẫn thiếu phép đo người mới. |
| Hi-Lite Studio | Không lưu trữ; hồ sơ hoàn chỉnh; 10 thợ, 12 dịch vụ | 7 / 0 | Huy đã chọn cho pilot; vẫn thiếu phép đo người mới. |
| Tech Nails Salon (cũ) | **Đã xóa khỏi NailIQ Production ngày 30/09 UTC** | 10 / 1 trước khi xóa | **Huy đã loại khỏi pilot**; Wix riêng không bị sửa. |
| Tech Nails Langley | Hồ sơ hoàn chỉnh; 1 thợ, 47 dịch vụ | 0 / 0 | Không thuộc cohort đã chọn. |
| Pucha Nail & Spa | Hồ sơ chưa hoàn chỉnh; 1 thợ, 10 dịch vụ | 0 / 0 | Chưa sẵn sàng để tự tính là salon pilot. |
| Kim's Original Hair | Hair salon; 1 thợ, 6 dịch vụ | 0 / 0 | Không tự chọn cho mẫu nail pilot. |

**Kết luận hiện tại:** Huy chỉ định **Hi-Lite Head Spa và Hi-Lite Studio** cho
pilot, không gửi thư mời, và sau đó **loại Tech Nails cũ**. Cùng thương hiệu
không tự loại hai địa điểm Hi-Lite. Theo quyết định tiếp theo của Huy,
**hai địa điểm này là toàn bộ cohort pilot**; Master Plan và bộ chấm đã đổi
theo, không còn cổng chọn salon thứ ba. Chưa có biên bản người mới hay 7–14
ngày đo thực tế. Vì thế Giai đoạn 5 / P1-07 vẫn **NOT PROVEN**, không phải
FAIL của phần mềm. Không tự thêm salon khác hoặc tính tenant QA là salon thật.

Ở checkpoint trước khi đổi chính sách, bộ chấm ba salon có 13/13 unit tests và
typecheck PASS; khi đó hai salon trả `not_proven`. Các số này là lịch sử, không
chứng nhận bộ chấm hai salon mới. Fixture synthetic luôn gắn nhãn **DỮ LIỆU
GIẢ** và không thay phép đo người thật.

Sau khi cập nhật quy tắc hai salon: **15/15 unit tests, typecheck, lint và
Next build local PASS**. Fixture synthetic hai salon tính ra PASS, còn hồ sơ
pilot thực tế vẫn **NOT PROVEN** vì chưa có lịch đo và phiếu người mới.

P1-01 cũng còn mở: PR #1439 đang Draft/CI xanh nhưng canary SMS qua NailIQ,
callback và receipt provider chưa có bằng chứng terminal. CI xanh không đóng
cổng thông báo của Giai đoạn 4.

## Điều kiện để bắt đầu đo pilot thật

1. Huy đã chỉ định đúng hai salon Hi-Lite; **không gửi thư mời**. Vẫn cần xác định
   người quan sát, người dùng thực tế, lịch đo 7–14 ngày và cách xử lý sự cố;
   không tự bật tính năng hay thay đổi
   hoạt động của salon.
2. Tuyển ít nhất một chủ lớn tuổi và hai tiếp tân ít dùng công nghệ; có người
   ngoài nhóm quen/kỹ thuật. Không dùng nhân viên nội bộ thay người mới.
3. Chốt kênh thông báo an toàn cho từng salon khi P1-01 chưa đóng; không dùng
   sender Production để thử QA và không tuyên bố SMS đã được giao chỉ từ CI.
4. Dùng phiếu `masterplan-two-salon-human-observation-sheet.md` cho pilot thật;
   phiếu `day5-human-acceptance-sheet.md` chỉ dành cho QA/Preview synthetic.
   Chỉ đưa số đo ẩn danh vào bộ chấm Ngày 21. Dừng và điều tra ngay nếu mất dữ
   liệu hoặc thao tác nhầm khách.

Mẫu tối thiểu có thể bố trí S1 = Hi-Lite Head Spa, S2 = Hi-Lite Studio; ít nhất
một chủ lớn tuổi, hai tiếp tân ít dùng công nghệ, có người ngoài nhóm quen/kỹ
thuật, và ít nhất một người được quan sát tại **mỗi** địa điểm. Người phụ trách
phải xác nhận người thật, ngày bắt đầu/kết thúc và sự đồng ý trước khi ghi số đo.
Với đúng ba người thử, ngưỡng ≥80% đồng nghĩa **cả ba** phải đạt; không làm
tròn 2/3 thành PASS. Chưa có xác nhận hoặc phép đo đó trong hồ sơ hiện tại.

Không thay đổi cấu hình, booking, provider hoặc dữ liệu salon trong tiền kiểm này.
Checklist onboarding pilot cũng được cập nhật local để khớp mục tiêu hai salon,
phân biệt phép đo người mới với đào tạo, yêu cầu receipt thông báo và không coi
rollback code là hoàn tác database/tin đã gửi.

## Cohort pilot do Huy chỉ định

Huy chọn **Hi-Lite Head Spa và Hi-Lite Studio** làm cohort pilot hiện tại,
**không cần gửi thư mời**. Anh từng chọn `tech-nails` (đã lưu trữ, không phải
`tech-nails-langley`) rồi yêu cầu **bỏ Tech Nails khỏi pilot**. Hai Hi-Lite có
membership Owner/tiếp tân trong Production.

| Hồ sơ | Trạng thái Production đọc lại | Điều kiện chưa giải quyết |
|---|---|---|
| `tech-nails` — **đã loại khỏi pilot** | Trước khi xóa: đã lưu trữ, 10 thợ, 49 dịch vụ, có Owner và tiếp tân. Sau phê duyệt riêng: tenant không còn trong NailIQ Production. | Không khôi phục hoặc dùng lại tenant cũ. |
| `tech-nails-langley` — **không được chọn** | Không lưu trữ, trial; 1 thợ, 47 dịch vụ; **không có thành viên salon** | Không tự thêm vào cohort hoặc cấp quyền. |

Trạng thái và số thành viên được đọc lại từ Production sau khi Huy nêu tên,
không đọc email hoặc danh tính cá nhân. Vai trò `Owner`/`receptionist` không
chứng minh độ tuổi, mức quen công nghệ hoặc sự đồng ý của người thật. Danh sách
**gồm đúng hai salon Hi-Lite theo quyết định mới** nhưng chưa có số đo người thật và chưa chứng minh
pilot 7–14 ngày hoàn thành.

### Bằng chứng lịch sử trước khi xóa Tech Nails cũ — đã loại khỏi pilot

Đọc lại Production sau khi Huy chọn: salon được tạm dừng thủ công từ 11/08/2026,
vẫn có **4 booking tương lai ở trạng thái confirmed** (và 3 cancelled). Chưa có
bằng chứng bốn lịch confirmed là synthetic, nên phải giữ nguyên và không dùng
chúng làm ca pilot giả định.

`resumeTenant()` trong code hiện tại xóa `archived_at` rồi phục hồi các cờ từ
`tenant_pause_snapshot`. Snapshot Production của salon này có **email outbound,
Voice AI, voice upsell, winback và phone OTP = true** trước khi tạm dừng. Vì vậy
thao tác “khôi phục” không phải chỉ mở quyền đăng nhập; nó có thể bật lại các
kênh thật và, với subscription active, mở các khả năng vận hành. Hiện tại các
kênh outbound tương ứng đang OFF. Không gọi `resumeSalonTenant`, sửa trực tiếp
`archived_at` hoặc bật salon khi chưa có kế hoạch an toàn được duyệt riêng,
bao gồm trạng thái mong muốn của từng kênh, bảo vệ bốn booking confirmed và
phương án rollback. Không suy ra việc chọn salon là phê duyệt khôi phục.

### Tách đồng bộ Wix theo phê duyệt riêng

Sau khi Huy loại Tech Nails khỏi pilot và duyệt tắt riêng đồng bộ của salon này,
Production `wix_integrations.enabled` của đúng `tech-nails` được đổi từ `true`
sang `false` lúc `2026-09-30 04:32:32 UTC`. Tiền kiểm: site ID chỉ có một
integration trong NailIQ, không có booking NailIQ mới đủ điều kiện chờ đẩy sang
Wix trong cửa sổ retry 24 giờ. Đọc lại sau khi đổi: salon vẫn lưu trữ, bốn
booking tương lai linked Wix vẫn ở trạng thái active, `last_run_at` không tiến
qua thời điểm tắt dù `wix_sync` cron chạy thành công ở 04:33–04:36 UTC. Mã
cron/webhook/writeback đều lọc `enabled=true`, nên cờ
OFF loại salon này khỏi các luồng đó. Các salon khác và Wix site không bị sửa.

Trình duyệt mở trang booking công khai của Tech Nails sau khi đổi: lịch dịch vụ
vẫn hiển thị ngày 30/09 và 36 khung giờ trống; không bấm bước xác nhận và không
tạo booking. Site ID trên trang Wix khớp chính xác `wix_integrations.site_id`
đã tắt (đối chiếu boolean, không ghi identifier ra báo cáo). Đây là bằng chứng
giao diện/lấy availability, **không** chứng minh
giao dịch booking end-to-end hoặc quyền quản lý trong dashboard Wix. Kết nối
Wix đang có không cấp quyền vào site Tech Nails nên không tuyên bố phần đó PASS.
Tại bước tách đồng bộ, chưa xóa `wix_integrations`, salon hoặc dữ liệu khách.
Trạng thái này đã được thay thế bởi bước xóa NailIQ-only bên dưới; không còn
integration để bật lại và không có rollback thông thường cho thao tác xóa.

### Xóa NailIQ-only sau phê duyệt đích danh

Huy xác nhận xóa vĩnh viễn đúng tenant `tech-nails` khỏi NailIQ, kể cả bốn bản
ghi lịch tương lai trong NailIQ, nhưng giữ nguyên Wix và tài khoản dùng salon
khác. Kiểm kê trước xóa không đọc PII: 1.218 booking (1.055 linked Wix), 50
service, 10 staff, 3 membership, 49 Voice AI sessions, 8 Wix lifecycle
writeback receipts đã `succeeded`, 3 ảnh nail-tryon. Một lần giao dịch thử
bị FK từ `client_profiles.preferred_staff_id` chặn và đã hoàn tác toàn bộ;
kiểm chứng lại sau lỗi vẫn còn nguyên 1.218 booking, 49 sessions và 8 receipts.
171 hồ sơ khách toàn cục tham chiếu thợ Tech Nails, không có booking/directory
ở salon khác; trong giao dịch thành công chỉ xóa liên kết preferred staff của
chúng, không xóa các hồ sơ toàn cục hoặc tài khoản auth.

Giao dịch tiếp theo khóa đúng tenant đã lưu trữ và chỉ chạy khi Wix sync OFF,
gỡ 171 liên kết preferred staff, xóa 49 sessions và 8 receipts bị FK chặn,
rồi xóa salon cùng các hàng phụ thuộc bằng cascade. Đọc lại Production sau
commit: `salons`, `bookings`, `staff`, `salon_members`, `wix_integrations`,
`voice_ai_sessions`, `wix_lifecycle_writeback_operations` cho UUID này đều 0.
Ba ảnh thuộc đúng prefix tenant được xóa qua Supabase Storage UI/API; hai
thư mục giữ chỗ tạo trong lúc dọn cũng được xóa. Đọc lại `storage.objects`
theo prefix tenant = 0. Hai salon Hi-Lite vẫn tồn tại. Không gọi Wix API,
không xóa Wix site, Wix Bookings app hay lịch ở Wix. Trang booking công khai
vẫn tải danh sách dịch vụ, nhưng không thử tạo lịch và không có quyền kiểm chứng
Wix dashboard/booking store; do đó chỉ khẳng định **không có thao tác ghi Wix**,
không tuyên bố Wix E2E PASS. Đây là xóa vĩnh viễn, không có rollback sản phẩm.
