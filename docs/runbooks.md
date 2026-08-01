# NailIQ Runbooks

## Resend Outbound Audit & Repair

Mục đích: đảm bảo tất cả salon đang dùng Resend (`salons.email_outbound_enabled = true`).

### Kiểm tra nhanh

```bash
cd /path/to/nailiq-audit
npm run resend:repair:dry
```

- In danh sách salon có `email_outbound_enabled` khác `true` (`false` hoặc `null`).
- Không sửa dữ liệu trong `--dry-run`.

### Sửa (repair)

```bash
cd /path/to/nailiq-audit
npm run resend:repair
```

Script sẽ (npm script truyền guard `--apply` bắt buộc):

- Set `email_outbound_enabled = true` cho các salon chưa bật.
- Guard an toàn: chỉ đổi khi giá trị đang là `false` hoặc `null`.
- Xác minh lại từng salon sau khi ghi và trả exit code khác 0 nếu repair chưa hoàn tất.

### Yêu cầu môi trường

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

> Cả 2 biến phải là project production.

### Xác minh sau chạy

```sql
SELECT
  COUNT(*) AS total_salons,
  COUNT(*) FILTER (WHERE email_outbound_enabled IS TRUE) AS enabled_true,
  COUNT(*) FILTER (WHERE email_outbound_enabled IS FALSE) AS enabled_false,
  COUNT(*) FILTER (WHERE email_outbound_enabled IS NULL) AS enabled_null
FROM public.salons;
```

Kỳ vọng:

- `enabled_false = 0`
- `enabled_null = 0`

### Lịch vận hành khuyến nghị

- Chạy `npm run resend:repair:dry` 1 lần/tuần hoặc sau onboarding salon mới.
- Nếu có salon chưa bật, chạy ngay `npm run resend:repair`.
