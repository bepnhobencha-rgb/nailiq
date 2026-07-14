# NailIQ — Môi trường E2E: Supabase local trong CI

**Ngày:** 2026-07-14 · **PR:** #745 · **Chưa merge, chưa deploy**

---

## 1. Vì sao chọn Supabase local (phương án B)

| | **A. Test project (hosted)** | **B. Supabase local trong CI** ✅ |
|---|---|---|
| Chi phí | $10/tháng | **$0** |
| Cách ly | DB dùng chung giữa các run | **DB mới tinh mỗi run** |
| Rác sót lại | Có thể — cần sweep | **Không thể** — container bị xoá |
| CI | Nhanh | Chậm hơn ~1–2 phút |

**Lý do quyết định:** sự cố xảy ra vì E2E ghi vào một database **sống lâu hơn lần chạy**. Cleanup nằm trong `test.afterAll()`; workflow đặt `cancel-in-progress: true`; push mới huỷ job; `afterAll` **không bao giờ chạy**; **5 tài khoản superadmin và một loạt salon fixture ở lại production suốt một tháng**.

Một container **bị huỷ cùng job** thì **không thể** tích tụ rác — dù job pass, fail, hay bị cancel giữa chừng. Nó sửa **nguyên nhân**, không phải triệu chứng. Và nó miễn phí.

---

## 2. Công cụ CI

| | |
|---|---|
| Runner | `ubuntu-latest` (Docker cài sẵn) |
| **Supabase CLI** | **`2.109.1`** — **PIN CỨNG**, không dùng `latest` |
| Node | 20 |
| Postgres | **17** (khớp production 17.6.x) |
| psql | có sẵn trên runner |

> **Vì sao pin CLI:** một CLI tự nhảy version có thể đổi cách stack boot hoặc đổi output của `supabase status` — và lỗi sẽ rơi trúng đầu người mở PR không liên quan tiếp theo.

---

## 3. Luồng GitHub Actions

```
1. Pre-flight   — supabase/bootstrap/schema.sql có chưa?
                  KHÔNG → SKIP to, giải thích rõ. KHÔNG BAO GIỜ fallback production.
2. setup-cli    — Supabase CLI 2.109.1 (pinned)
3. supabase start — Postgres 17 + GoTrue + PostgREST trong Docker
4. GUARD        — assertNotProductionFromEnv() chạy TRƯỚC khi psql được trỏ vào đâu
5. psql -f schema.sql  — dựng schema từ database TRỐNG
6. check-schema-parity — số bảng/cột/policy/function/trigger/index + RLS có bật không
7. seed-e2e     — fixture có marker, chạy 2 LẦN để chứng minh idempotent
8. build + start app
9. playwright   — E2E suite
10. e2e-sweep         — if: always()
11. supabase stop --no-backup — if: always()  ← DATABASE BỊ XOÁ
```

**Thứ tự bước 4 là có chủ ý.** `supabase status` đưa ra một service-role key; một service-role key chĩa nhầm database chính là khẩu súng đã lên đạn mà cả cuộc audit này nói về. Guard phải lên tiếng **trước** khi `psql` được trỏ vào bất cứ đâu.

---

## 4. Không còn secret production nào

```
grep 'secrets.*SUPABASE' .github/workflows/e2e.yml  →  0
```

Secret duy nhất còn lại trong file: `GITHUB_TOKEN` và `ANTHROPIC_API_KEY` (job AI-triage đọc report test fail) — **không phải secret database**.

URL/anon key/service-role key của stack local do **CLI sinh ra lúc chạy**, được `::add-mask::` để không lọt vào log, và **không** ghi vào artifact.

---

## 5. Chặn toàn bộ external integration

Mọi credential provider đều **để rỗng có chủ ý** trong job:

| Provider | Trạng thái |
|---|---|
| Twilio (SMS/OTP) | `DISABLE_OUTBOUND_SMS=1` (kill-switch cứng) + `TWILIO_*=""` + số 555 không định tuyến được |
| Resend (email) | `RESEND_API_KEY=""` + Inbucket local bắt mọi mail |
| Stripe | `STRIPE_SECRET_KEY=""`, `STRIPE_WEBHOOK_SECRET=""` |
| Anthropic | `ANTHROPIC_API_KEY=""` + `AI_PREFILL_E2E_MOCK=services` |
| OpenAI (voice) | `OPENAI_API_KEY=""` |
| Wix | `WIX_API_KEY=""` |
| Square | không có credential trong CI |
| Cron | `CRON_SECRET=""` → route cron từ chối |

**Rỗng không phải là thiếu sót ở đây** — mỗi client factory đọc key và no-op (hoặc throw) khi không có. **Không có key nào để với tới production.** Spec nào cần provider thì phải mock hoặc **skip to**; **không** cái nào được fallback về tài khoản thật.

`[auth.sms]` trong `config.toml` cũng tắt hẳn — test database **không thể** với tới Twilio kể cả do vô ý. Suite này từng bị tính tiền **555 tin nhắn thật**.

---

## 6. Seed E2E

`scripts/seed-e2e.ts` — **compose lại helper sẵn có** (`e2e/helpers/db.ts`), không viết insert mới. Một seed lệch khỏi helper sẽ tạo fixture mà spec không dùng được, và lỗi đó **trông y hệt bug sản phẩm**.

| Quy tắc | Cách thực hiện |
|---|---|
| Email | `e2e-<uuid>@nailiq.test.invalid` — TLD dành riêng (RFC 2606), **không người nào sở hữu được** |
| Phone | dải **555** — không định tuyến được, **và** bị app chặn gửi thật |
| Password | **ngẫu nhiên mỗi run**, chỉ trong bộ nhớ, **không bao giờ log** |
| Marker | slug `e2e-baseline-<GITHUB_RUN_ID>` |
| Idempotent | `seedTestSalon()` gọi `cleanupTestSalon()` trước → chạy lại là **thay**, không nhân đôi. CI chạy seed **2 lần** để chứng minh |
| Superadmin | **KHÔNG seed.** Spec nào cần thì tự tạo và tự dọn. Một `founder` thường trực trong seed **chính là cách cái cũ thoát ra ngoài** |

> **Vì sao nhúng run ID:** salon còn sót trên production tên là `e2e-rc-mobile-**29298115054**` — và **chính run ID nhúng trong slug** là thứ chứng minh workflow nào đã tạo ra nó.

---

## 7. 🔴 Lỗ hổng cùng loại — phát hiện thêm trong nhóm này

`e2e/helpers/db.ts:300` — `seedTestUser()` **cũng** có mật khẩu hardcode (`"E2E_testpass_2026!"`), **y hệt** `seedTestSuperadmin` đã vá ở NHÓM 4. Nó **cũng tạo auth user thật**, và cũng nằm trong **repo PUBLIC**.

**Em đã bỏ sót nó ở NHÓM 4** — lúc đó chỉ vá file `superadmin.ts` mà không quét hết các helper seed khác. **Đã vá trong PR này:** password ngẫu nhiên mỗi run, email `randomUUID()`.

Bài học: khi vá một lớp lỗ hổng, **phải quét hết cả lớp**, không chỉ chỗ được báo.

---

## 8. Kiểm tra

| | |
|---|---|
| TypeScript | ✅ 0 lỗi |
| Unit test | ✅ **76/76** (thêm 20 test cho dump-verifier) |
| Lint | ✅ 84/101 — đúng baseline |
| YAML workflow | ✅ hợp lệ |
| Secret Supabase trong workflow | ✅ **0** |
| **Live-fire** | ✅ `seed-e2e.ts` chĩa vào production → **bị guard chặn** |

---

## 9. 🚧 ĐANG BỊ CHẶN — cần đúng 1 lệnh của Huy

**CI chưa chạy được full E2E**, và em **không báo pass giả**.

`supabase/bootstrap/schema.sql` **chưa tồn tại**. Nó cần **mật khẩu Postgres** — thứ CI không có và **không được có**, và em cũng không có (`.env.local` chỉ có Supabase URL + key, **không có `DATABASE_URL`**). Em **không đi tìm password trong source hay log** (đúng quy định), và **không dùng service-role key thay cho database password**.

**Lệnh duy nhất anh cần chạy** — xem `docs/audit/SUPABASE-LOCAL-BASELINE.md` §"Cách tạo baseline".

Sau đó: `npx tsx scripts/verify-schema-dump.ts` → nếu pass thì gỡ dòng `supabase/bootstrap/*.sql` trong `.gitignore` và commit. CI sẽ tự chạy full E2E từ lần push kế tiếp.

**Trong lúc chưa có file đó:** pre-flight **skip to** kèm giải thích, và **không có đường fallback về production** — theo đúng thiết kế.

---

## 10. Không đụng 262 migration

✅ Không xoá · ✅ Không squash · ✅ Không đổi timestamp · ✅ Không rewrite Git history · ✅ Không sửa `schema_migrations` của production · ✅ Không `db push` / `db reset` / `migration repair` lên production.

Kế hoạch consolidation cho sprint sau: xem `docs/audit/SUPABASE-LOCAL-BASELINE.md` §cuối.
