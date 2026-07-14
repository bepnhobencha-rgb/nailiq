# NailIQ — E2E chạy đầy đủ lần đầu tiên

**Ngày:** 2026-07-14 · **CI run:** [29323852182](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/29323852182) · **PR:** #745 (**chưa merge**)

Đây là lần đầu tiên trong lịch sử dự án E2E chạy được **toàn bộ suite** — trên một database riêng, **không đụng production**.

---

## 1. KẾT QUẢ

| Shard | Pass | Fail | Skip | Tổng | Thời gian |
|---|---|---|---|---|---|
| non-RC tests | **88** | **43** | 3 | 134 | 46,9 phút |
| receptionist-center | **58** | **7** | 1 | 66 | 9,7 phút |
| **TỔNG** | **146** | **50** | **4** | **200** | ~52 phút |

**Tỉ lệ pass: 73%** (146/200).

> **Không một test nào flaky.** Cả 50 lỗi đều fail ở **cả lần chạy gốc lẫn lần retry** → deterministic. Đây là con số đáng tin, không phải nhiễu.

---

## 2. HẠ TẦNG — 100% XANH TRÊN CẢ HAI SHARD

Mọi bước hạ tầng đều `success` ở **cả hai** shard:

| Bước | non-RC | receptionist-center |
|---|---|---|
| Pre-flight (baseline có mặt) | ✅ | ✅ |
| Supabase CLI 2.109.1 (pinned) | ✅ | ✅ |
| **Supabase Local khởi động** (Docker) | ✅ | ✅ |
| **Production guard** — "not production" | ✅ | ✅ |
| **Baseline apply** lên DB trống | ✅ | ✅ |
| **Schema parity** | ✅ | ✅ |
| **Seed E2E** | ✅ | ✅ |
| **Seed lần 2** (idempotent) | ✅ | ✅ |
| Build app + server start | ✅ | ✅ |
| **Sweep** (`if: always()`) | ✅ | ✅ |
| **`supabase stop --no-backup`** (`if: always()`) | ✅ | ✅ |

**Chỉ duy nhất bước `Run E2E tests` fail** — tức là lỗi **test sản phẩm**, không phải hạ tầng.

### Schema parity (đo trên chính CI)
```
✓ tables        81 / 81       ✓ policies    101 / 101
✓ columns     1064 / 1064     ✓ functions    65 / 65
✓ triggers      24 / 24       ✓ indexes     265 / 265
✓ anon            75 / 75 tables
✓ authenticated   75 / 75 tables
✓ service_role    81 / 81 tables
✓ RLS enabled on every core table
```

| | |
|---|---|
| **Secret production dùng trong CI** | **0** — `grep 'secrets.*SUPABASE'` = 0 |
| **Dữ liệu production mới** | **KHÔNG** — E2E không hề chạm tới production |
| **Lỗi Supabase Local** | **0** |
| **Lỗi seed / cleanup** | **0** |
| **Lỗi app server** | **0** |
| **Lỗi hạ tầng** | **0** |

---

## 3. 🔑 LỖI NÀO DO PR #745? — KHÔNG CÁI NÀO

**Bằng chứng cấu trúc, không phải suy đoán:**

```
PR #745 — 19 file thay đổi:
  .github/workflows/e2e.yml      scripts/*.ts, *.sh
  supabase/bootstrap/*           docs/*
  e2e/helpers/db.ts              .env.example, .gitignore
  src/shared/lib/__tests__/verifySchemaDump.spec.ts   ← file DUY NHẤT trong src/, và nó là UNIT TEST

  File logic sản phẩm bị đổi: 0
```

**PR này không đụng một dòng code sản phẩm nào.** Hành vi sản phẩm y hệt `main`. Nên nó **không thể** gây ra một lỗi test sản phẩm.

Con đường duy nhất PR #745 có thể gây lỗi là qua **môi trường test** (schema / seed / reference data). Bằng chứng môi trường lành mạnh:
- **146 test PASS**, gồm rất nhiều test đọc/ghi DB
- DOM snapshot lúc fail cho thấy **trang render đúng** (salon, giờ mở cửa, dịch vụ)
- **Schema parity khớp production 100%**, kể cả ma trận GRANT và 6 bảng chặn `anon`
- Seed chạy **2 lần** không lỗi

> **Trung thực về giới hạn:** để chứng minh tuyệt đối "có sẵn / do PR", phải chạy cùng suite trên `main` với cùng hạ tầng. **Không làm được** — vì `main` **chưa có** hạ tầng đó (đó chính là lý do PR này tồn tại). Lập luận cấu trúc ở trên (0 file sản phẩm bị đổi) là bằng chứng mạnh nhất có thể có, và em nói rõ nó là lập luận chứ không phải phép đo.
>
> **Kết luận:** `Pre-existing product issue exposed by restored E2E`.

---

## 4. PHÂN LOẠI 50 LỖI

| Nhóm | Số test | Phân loại | Issue |
|---|---|---|---|
| **Booking công khai kẹt ở phone-first gate** | ~30 | **Stale test** | [#746](https://github.com/bepnhobencha-rgb/nailiq/issues/746) |
| **Picker không loại khung giờ đã bận** | 2 (+1 ở RC) | **⚠️ Nghi bug sản phẩm** | [#747](https://github.com/bepnhobencha-rgb/nailiq/issues/747) |
| **`/register`: form auth + lỗi a11y** | 8 | 7 chưa xác định + **1 bug a11y thật** | [#748](https://github.com/bepnhobencha-rgb/nailiq/issues/748) |
| **Receptionist Center** | 7 | Hỗn hợp: responsive (2), rendering (1), owner dashboard (2), bed auto-assign (1), conflict (1) | [#749](https://github.com/bepnhobencha-rgb/nailiq/issues/749) |
| **Infrastructure issue** | **0** | — | — |
| **Flaky** | **0** | — | — |

### Nhóm lớn nhất — phone-first gate (≈30 test)
DOM snapshot lúc fail:
```yaml
- heading "Book this salon"
- textbox "Phone number": (604) 555-0000
- textbox "Your name": Test Guest
- checkbox "I agree to receive appointment confirmation and reminder SMS…" [checked]
- tablist "How would you like to book?": tab "Individual" | tab "Group 👥" [selected]
```
Trang **render đúng**. Các spec được viết **trước khi** phone-first gate + SMS consent lên sản phẩm (#346, #487) — chúng giả định trang mở thẳng ở bước chọn dịch vụ. **Test cũ hơn tính năng.**

### Hai lỗi KHÔNG thể đổ cho test lỗi thời
1. **`a11y register`** — `1 form control(s) without an accessible name`. axe báo, không phải giả định. Người dùng screen reader gặp một ô nhập **không biết là ô gì**, ngay trên trang **đăng ký chủ tiệm**.
2. **`conflict-1` / `conflict-3` / `eb-4`** — **ba** spec ở **hai** vùng độc lập cùng báo: **khung giờ đã có người đặt vẫn chọn được**. Ràng buộc GIST `bookings_no_overlap` ở tầng DB vẫn chặn ghi, nên **không** double-book thật được — nhưng UX sẽ là "chọn được rồi báo lỗi lúc submit". **Cần xác minh tay trước khi kết luận.**

---

## 5. KHUYẾN NGHỊ VỀ PR #745

### ✅ NÊN MERGE

| Điều kiện | Đạt? |
|---|---|
| Hạ tầng Supabase Local ổn định | ✅ 100% xanh, cả 2 shard |
| Không dùng production secret | ✅ **0** |
| Cleanup ổn định (`if: always()`) | ✅ sweep + `supabase stop` |
| Baseline an toàn (0 dữ liệu khách, 0 secret) | ✅ verify bằng 2 công cụ độc lập |
| Schema parity pass | ✅ khớp tuyệt đối, kể cả GRANT |
| Test fail là lỗi có sẵn, không do PR | ✅ **0 file sản phẩm bị đổi** |
| PR không đổi business logic production | ✅ |
| CI báo fail vì product test, **không giả pass** | ✅ |

| Điều kiện CẤM merge | Có vi phạm? |
|---|---|
| Lỗi hạ tầng do PR | ❌ không |
| Dữ liệu production bị ghi | ❌ không |
| Baseline thiếu RLS / object quan trọng | ❌ không |
| Cleanup không chạy | ❌ không |
| Workflow fallback production | ❌ không |
| Test fail do seed/schema sai | ❌ không |
| PR đổi app production ngoài phạm vi | ❌ không |

### ⚠️ Hệ quả cần biết trước khi merge
Sau khi merge, **E2E sẽ ĐỎ trên mọi PR** cho tới khi 50 lỗi kia được xử lý.

Đó là **sự thật, không phải regression** — 50 lỗi này **đã tồn tại từ lâu**, chỉ là trước giờ không ai nhìn thấy vì suite không chạy nổi. Merge PR này = **bật đèn**, và trong phòng có 50 con gián.

Có 2 lựa chọn, cần anh quyết:
1. **Merge ngay** — chấp nhận CI đỏ, coi 50 lỗi là backlog (#746–#749). Ưu: E2E không bao giờ chạm production nữa, ngay từ hôm nay.
2. **Merge + tạm `continue-on-error`** cho bước E2E — CI xanh, nhưng kết quả vẫn hiện trong log/artifact. Nguy: đèn vàng dễ bị bỏ qua và lại ngủ quên như cũ.

**Em nghiêng về (1).** Đỏ mà thật thì tốt hơn xanh mà giả — đây chính là bài học của cả cuộc audit này.

---

## 6. RỦI RO CÒN LẠI

| # | Rủi ro | Mức |
|---|---|---|
| 1 | **Picker cho chọn khung giờ đã bận** (#747) — chưa xác minh tay | 🔴 **CAO nếu đúng** |
| 2 | Lỗi a11y trên `/register` (#748) — chặn người khiếm thị đăng ký | 🟠 TB |
| 3 | E2E sẽ đỏ trên mọi PR cho tới khi dọn 50 lỗi | 🟠 TB (quy trình) |
| 4 | 262 migration vẫn không dựng lại được DB (chưa squash — cố ý) | 🟡 THẤP-TB |
| 5 | Baseline phải dump lại tay khi schema production đổi | 🟡 THẤP (parity check sẽ bắt) |
| 6 | 5 tài khoản `.test.invalid` vẫn tồn tại trên prod (đã disable, giữ làm bằng chứng) | 🟡 THẤP |

---

## 7. XÁC NHẬN PHẠM VI NHÓM 14

✅ Không sửa lỗi UI · ✅ Không đổi selector · ✅ Không skip test · ✅ Không thêm retry che lỗi · ✅ Không giảm assertion · ✅ Không merge · ✅ Không deploy · ✅ Không sửa gì trong nhóm này (kể cả hạ tầng — vì không có lỗi hạ tầng nào).
