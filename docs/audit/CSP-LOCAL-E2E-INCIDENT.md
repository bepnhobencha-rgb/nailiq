# Sự cố CSP — khi công cụ test làm hỏng sản phẩm rồi đổ lỗi cho sản phẩm

**Ngày:** 2026-07-14 · **Vá tại:** PR #751 (`76833a2`) · **Không ảnh hưởng production**

Đây là hồ sơ sai lầm của chính em. Nó được viết ra để **không tái diễn**, nên nó không tô hồng chỗ nào.

---

## 1. Chuyện gì đã xảy ra

PR #745 dựng Supabase local cho E2E. Nó chạy. Schema khớp production tuyệt đối. 155 test pass. Nhưng **50 test đỏ**, và em kết luận:

> *"0 lỗi hạ tầng — cả 50 lỗi đều là bug sản phẩm có sẵn, PR #745 không gây ra cái nào."*

**Sai.** **10 trong 50 lỗi là do chính PR #745.**

---

## 2. Nguyên nhân kỹ thuật

`next.config.ts` đặt CSP:

```
connect-src 'self' https://*.supabase.co wss://*.supabase.co …
```

Đúng — **chừng nào Supabase luôn là bản hosted**. Nhưng E2E giờ chạy với Supabase **local**: `http://127.0.0.1:54321`. Origin đó **không nằm trong `connect-src`**, nên trình duyệt **từ chối mọi request**:

```
Fetch API cannot load http://127.0.0.1:54321/rest/v1/rpc/public_booking_occupancy_for_range.
Refused to connect because it violates the document's Content Security Policy.
```

---

## 3. Vì sao nó vô hình

Đây là phần đáng sợ.

- **Server không ném lỗi gì.** Request bị chặn **ở trình duyệt**, chưa bao giờ rời khỏi máy khách. Log server **sạch trơn**.
- **App hiện thông báo bắt-tất-cả**: *"Could not complete booking. Please try again."*
- **Playwright chỉ báo**: `booking-success` không hiện.

Ba tầng đều nói *"booking hỏng"*. **Không tầng nào nói vì sao.** Chỉ **console trình duyệt** biết — và console không có trong bất kỳ báo cáo nào.

---

## 4. Hậu quả: một cảnh báo bảo mật giả

RPC bị chặn có tên **`public_booking_occupancy_for_range`** — chính là thứ cho picker biết **khung giờ nào đã có người đặt**.

Bị chặn → picker không nhận được dữ liệu bận → **hiện mọi khung giờ đều trống** → `conflict-1` và `conflict-3` fail.

Em đọc kết quả đó và mở **[Issue #747](https://github.com/bepnhobencha-rgb/nailiq/issues/747): "Booking picker does not exclude conflicting time slots (possible double-booking)"**, mức **HIGH**, và nói với Huy *"cần mở thử tay để chốt — có thể khách đặt trùng giờ"*.

**Picker hoàn toàn bình thường.** Em đã tạo ra một cảnh báo double-booking từ hư không, và bắt Huy lo về nó.

---

## 5. Vì sao em kết luận sai — đây mới là lỗi thật

Em **có** điều tra. Em kiểm hai thứ:

1. Gọi thẳng RPC `create_public_booking` lên chính baseline đó → `{"success": true, "booking_id": "…"}` ✅
2. Đọc `submitPublicBooking` → **không đọc biến môi trường nào có thể ném lỗi**; mọi side-effect sau RPC đều fire-and-forget ✅

**Cả hai đều ĐÚNG. Cả hai đều LẠC ĐỀ.**

Chúng chứng minh *"server và database không có lỗi"*. Chúng **không** chứng minh *"trình duyệt gọi được tới database"* — và đó chính là chỗ hỏng.

Em dừng lại **đúng lúc bằng chứng minh oan cho mình**. Hai dữ kiện đó gỡ tội cho hạ tầng của em, nên em thôi tìm. **Đó là lỗi thật, không phải cái CSP.**

---

## 6. Thứ vạch trần nó

**Trace của trình duyệt** — thứ em chỉ bật lên vì **bản nháp đầu của booking smoke bị đỏ** và em muốn biết tại sao.

Nói cách khác: **cổng smoke lập công trước cả khi nó kịp xanh.** Nó buộc em nhìn vào chỗ mà báo cáo không nhìn.

---

## 7. Bản vá

`next.config.ts` — suy ra origin Supabase từ `NEXT_PUBLIC_SUPABASE_URL` rồi thêm vào `connect-src`:

```ts
supabaseConnectSrc("http://127.0.0.1:54321")
  → ["http://127.0.0.1:54321", "ws://127.0.0.1:54321"]

supabaseConnectSrc("https://fshmobzyjhmtvndobwsy.supabase.co")
  → ["https://fshmobzyjhmtvndobwsy.supabase.co", "wss://…"]     // đã được *.supabase.co cho phép sẵn
```

**Đây là quy tắc đúng cho MỌI cấu hình, không phải cửa sau cho test:** build trỏ vào Supabase nào thì trình duyệt phải được phép gọi Supabase đó. **Production không đổi gì.**

### Chặt về bảo mật (21 unit test — `src/shared/lib/__tests__/cspSupabaseOrigin.spec.ts`)
- Chỉ chấp nhận `http:` / `https:` (`data:` cho origin là chuỗi `"null"` → loại)
- **Không bao giờ** phát `*`, `http:`, `https:`, `ws:`, `wss:`, `'unsafe-inline'`
- **Không thể inject CSP directive**: `https://evil.example/; script-src * 'unsafe-inline'` → thu về `https://evil.example`, vì `origin` là `scheme://host[:port]` và **không thể chứa dấu cách hay chấm phẩy**
- 9 loại đầu vào rác → trả rỗng, **không bao giờ tạo CSP hỏng cú pháp**

---

## 8. Số liệu: trước / sau

| | Em đã báo (SAI) | **Thật** |
|---|---|---|
| Pass | 146 | **155** |
| **Fail** | **50** | **40** |
| Skip | 4 | 5 |
| **Lỗi hạ tầng** | **"0"** | **10** |

### Tự khỏi, không sửa một dòng sản phẩm nào
`Complete booking end-to-end` ✓ · `booking-errors` conflict-1 / conflict-3 / edge-19 / edge-20 ✓ · `booking-security` sec-1 / sec-2 / xss-3 ✓ · `group-booking/happy-path` ✓

---

## 9. Cách ngăn tái diễn

| # | Biện pháp | Trạng thái |
|---|---|---|
| 1 | **CSP suy ra từ env** — hết cứng nhắc theo một host | ✅ PR #751 |
| 2 | **21 unit test** khoá cả chiều "cho phép đúng" lẫn chiều "không mở rộng" | ✅ PR #751 |
| 3 | **Log server Next** upload thành artifact mọi lần fail | ✅ PR #751 |
| 4 | **Trace + screenshot + DOM** upload khi smoke đỏ | ✅ PR #751 |
| 5 | **Booking smoke ĐỌC HÀNG TỪ POSTGRES** — không tin màn hình | ✅ PR #751 |
| 6 | Booking smoke **theo dõi network**, fail nếu request booking trả 4xx/5xx | ✅ PR #751 |
| 7 | Booking smoke **assert VẮNG MẶT** dòng `Could not complete booking` | ✅ PR #751 |

### Bài học không nằm trong code

**Khi bằng chứng gỡ tội cho chính mình, đó là lúc phải tìm KỸ HƠN, không phải lúc dừng.**

Và: **console trình duyệt là một tầng bằng chứng riêng.** Server log sạch **không** có nghĩa là không có lỗi — nó chỉ có nghĩa là lỗi chưa tới được server.
