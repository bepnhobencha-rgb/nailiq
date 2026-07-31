# Hướng dẫn chuyển Salons sang Resend

Mục tiêu: sau bước này không còn salon đang hoạt động nào có `email_outbound_enabled = false`
(khi gói Resend đã lên Pro và các salon cần dùng Resend).

## Chạy migration

```bash
cd /Users/huytran/nailiq
npm run migration:resend-run
```

### Ghi chú
- Script chạy theo cơ chế **dry-run trước**, rồi mới apply, rồi verify lại.
- Mặc định chỉ xử lý salon đang active (`archived_at IS NULL`).
- Muốn tính cả archived (nếu cần): sửa script thêm cờ `--include-archived`.

### Kiểm chứng hoàn tất
- Output cuối cùng phải có:
  - `✅ No remaining active salons still with email_outbound_enabled = false.`  
  hoặc
  - `✅ Không còn salon active nào có email_outbound_enabled = false.`

## Query kiểm chứng SQL nhanh

```sql
SELECT COUNT(*) FILTER (
  WHERE email_outbound_enabled = false AND archived_at IS NULL
) AS active_salons_need_resend
FROM salons;
```

Kết quả phải bằng `0`.
