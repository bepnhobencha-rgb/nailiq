# CI Quality Gates — hai cấp, và vì sao

**Cập nhật:** 2026-07-14

---

## 1. Hai cấp

| | **Cấp A — `Smoke (required)`** | **Cấp B — Full E2E** |
|---|---|---|
| Số test | **8** | **200** |
| Thời gian | ~6 phút | ~50 phút |
| Trạng thái | **XANH** | **ĐỎ** (40 fail) |
| Có gác merge không | ✅ **CÓ** | ❌ chưa |
| `continue-on-error` | **không** | **không** |
| `\|\| true` trên bước test | **không** | **không** |

**Một cấp không thể làm cả hai việc.**

Full suite **phải đỏ** — nó đang nói sự thật về 40 lỗi. Nhưng một backlog 40 lỗi **không thể** làm cổng: nó khoá mọi PR không liên quan ngay từ ngày đầu, và việc đầu tiên ai cũng làm là **học cách bypass**.

> **Cổng bị bypass còn tệ hơn không có cổng — vì nó trông giống như đang bảo vệ.**

---

## 2. Full E2E **không** được làm xanh giả

Tuyệt đối **không**:
- ❌ xoá test đang fail
- ❌ skip thêm test
- ❌ hạ assertion
- ❌ tăng retry để che lỗi
- ❌ `continue-on-error` trên bước chạy test
- ❌ `|| true` trên bước chạy test
- ❌ xoá screenshot / trace / report của test fail

Nó **vẫn** báo: tổng test, pass, fail, skip, danh sách test đỏ, trace, screenshot, **và log server Next**.

### `|| true` còn tồn tại ở đâu (và vì sao không sao)
Chỉ trên các bước **in log** và **tóm tắt** (`tail next-server.log`, `playwright-summary.js`). **Không một bước chạy test nào** bị che. `continue-on-error` duy nhất nằm ở bước **tải artifact** của job AI-triage — có sẵn từ trước.

---

## 3. Số liệu chính thức

**200 test — 155 pass · 40 fail · 5 skip** (sau bản vá CSP, PR #751)

| Shard | Pass | Fail | Skip |
|---|---|---|---|
| non-RC tests | 97 | 34 | 3 |
| receptionist-center | 58 | 6 | 2 |

### ⚠️ 40 lỗi này **chưa được phân loại xong**
Điều duy nhất **đã chứng minh**: chúng **không do CSP** (vẫn đỏ sau bản vá).

**Chưa** chứng minh chúng là bug sản phẩm. Có thể là test lỗi thời, có thể là bug thật, **có thể là một thiếu sót hạ tầng khác chưa tìm ra — đúng như CSP đã từng là.** Gọi cả 40 cái là *"pre-existing product bug"* bây giờ sẽ lặp lại đúng sai lầm vừa rồi (xem [`CSP-LOCAL-E2E-INCIDENT.md`](./CSP-LOCAL-E2E-INCIDENT.md)).

Issue theo dõi: [#746](https://github.com/bepnhobencha-rgb/nailiq/issues/746) · [#748](https://github.com/bepnhobencha-rgb/nailiq/issues/748) · [#749](https://github.com/bepnhobencha-rgb/nailiq/issues/749) — [#747 đã đóng: báo động giả do CSP](https://github.com/bepnhobencha-rgb/nailiq/issues/747)

---

## 4. Hạ tầng test — bất biến

| Tính chất | Cách bảo đảm |
|---|---|
| **Không secret production trong CI** | `grep 'secrets.*SUPABASE'` = **0** |
| **Không bao giờ ghi vào production** | `guardProduction.ts` — khoá theo Supabase project ref + hostname, **fail-closed** |
| **Database mới tinh mỗi lần chạy** | `supabase start` → `supabase stop --no-backup` (`if: always()`) |
| **Rác không thể tích tụ** | Container bị huỷ cùng job — kể cả khi job bị **cancel** |
| **Schema khớp production** | `check-schema-parity.ts` — 81 bảng · 101 RLS policy · GRANT matrix · RLS bật |
| **Không lộ dữ liệu khách** | `verify-schema-dump.ts` — baseline là schema-only, 0 COPY, 0 INSERT, 0 credential |
| **Provider ngoài bị chặn** | Twilio / Resend / Stripe / Anthropic / OpenAI / Wix — **key rỗng** + `DISABLE_OUTBOUND_SMS=1` |

---

## 5. Khi nào Full E2E được lên required

Khi **40 → 0**.

Lúc đó thêm vào danh sách required:
- `E2E (Playwright) — non-RC tests`
- `E2E (Playwright) — receptionist-center`

Chi tiết cấu hình: [`BRANCH-PROTECTION-AND-SMOKE-GATE.md`](./BRANCH-PROTECTION-AND-SMOKE-GATE.md)
