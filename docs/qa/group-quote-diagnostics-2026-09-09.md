# Chẩn đoán HTTP 503 của booking nhóm — 2026-09-09

## Bằng chứng và phạm vi

Base `bffd41ed9a5e266a806732eb013e7b194c61e67a`, nhánh local `fix/group-quote-diagnostics-20260909`.

Deployment Production `dpl_9KsVugC1Mgs6STbzUzbPjLfr8mbn` ghi hai POST `/api/booking/group-quote` trả 503 lúc 20:23:58 và 20:24:04 UTC. ID lần lượt `fkdc6-1788985438964-d78fe4d4f74e` và `579z4-1788985444775-54588d2d4986`. Log CLI có `traceId` rỗng, `logs: []`, không có response body. Metrics ghi hai invocation 503, user agent Chrome 152 trên Windows, `error_code` nền tảng rỗng. Metrics tự làm tròn cửa sổ query thành 20:21–20:26 UTC.

Chưa xác định đây là QA hay traffic khách, chưa biết nhánh trả lỗi và ảnh hưởng booking. Hai sự kiện này xảy ra sau cửa sổ kiểm tra Production ban đầu 20:21:10–20:23:50 UTC; không dùng kết quả sạch của cửa sổ trước để phủ nhận chúng. Bảy 503 lịch sử của deployment trước cũng chưa phân loại.

## Thay đổi

Thêm warning JSON vào đúng các nhánh route đã trả 503. Metadata chỉ gồm event `group_quote_unavailable`, status `503`, stage cố định và outcome được lọc bằng allowlist.

| Stage | Vị trí |
|---|---|
| `ip_metering` | Không lấy được quyết định metering theo IP |
| `phone_metering` | Không lấy được quyết định metering theo điện thoại |
| `authorization` | Ranh giới quyền/cấu hình salon từ chối |
| `quote_resolution` | Bộ tính quote trả kết quả lỗi |

Outcome được phép: `quote_unavailable`, `booking_unavailable`, `slot_conflict`, `pricing_invalid`; giá trị khác chuyển thành `unrecognized_failure` trong log. Không ghi request, ID salon, tên khách, IP, số điện thoại, token hay raw dependency error. Không dùng ErrorReporter có side effect ghi database/triage.

Giữ nguyên HTTP status/body/header, thứ tự guards, tham số rate limit, authorization và logic giá. Nếu console sink ném lỗi, response vẫn giữ nguyên. Exception ngoài các nhánh 503 đã xử lý vẫn giữ cách truyền lỗi cũ.

## Kiểm chứng

- PASS: 53/53 unit trong ba file, gồm 35 ca route (22 ca mới). Kiểm tra sáu tổ hợp stage/outcome 503, exact metadata, outcome bất thường, sink lỗi, các HTTP status khác không tạo warning 503 và exception gốc không bị nuốt.
- PASS: ESLint hai file code/test thay đổi, `git diff --check`.
- PASS: review độc lập, không có finding cần sửa về privacy hoặc thay đổi hành vi.
- PASS: production build Webpack và typecheck tuần tự. Log `build.log`, `typecheck.log` trong thư mục bằng chứng patch.
- Không chạy API POST Production, không gọi nhà cung cấp hoặc sửa dữ liệu khách. Unit dùng dependency mocks; build dùng cấu hình loopback, không có credential Production.

Lệnh unit có thể chạy lại với Node 20:

```sh
node node_modules/vitest/vitest.mjs run src/app/api/booking/group-pricing-routes.spec.ts src/shared/booking/__tests__/groupBookingPricing.spec.ts src/shared/booking/__tests__/groupBookingPricingRolloutBoundary.spec.ts
```

Kết quả 53/53 lúc 13:34:46 Vancouver được lưu trong tool transcript của tác vụ, không có file unit log riêng. Review độc lập chỉ đọc, không tính là một lượt test bổ sung.

## Giới hạn và phát hành

Đây là bản bổ sung bằng chứng cho lần lỗi tiếp theo, **chưa sửa hoặc chứng minh nguyên nhân 503**. Log cho biết bước phát sinh lỗi; không bảo đảm nền tảng lưu/gửi log thành công và không hồi phục response body lịch sử. Các nhánh con bên trong authorization vẫn cần điều tra tiếp nếu đó là stage bị lỗi.

Tại thời điểm chốt kiểm chứng local, patch chưa có CI/Preview; kết quả xuất bản được theo dõi riêng trên PR. Bằng chứng điều tra ở `/Users/huytran/nailiq-audit-results-20260907/post-release-qa/main-bffd-503-cli.jsonl`, `main-bffd-503-metrics.json`; kiểm chứng patch ở `/Users/huytran/nailiq-audit-results-20260907/group-quote-diagnostics/`.
