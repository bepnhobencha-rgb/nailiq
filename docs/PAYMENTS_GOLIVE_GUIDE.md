# Hướng dẫn GO-LIVE thanh toán (Square OAuth + Stripe Connect + Apple Pay)

> Mục tiêu: bật cho salon connect 1-bấm và để tiền no-show chảy về tài khoản
> salon (không phải platform account). Code đã sẵn — đây là phần cấu hình tài
> khoản mà chỉ Huy làm được (OAuth app, bật Connect, verify domain).
>
> Khi xong từng bước, đưa giá trị cho em → em set vào Vercel env + DB, không cần
> Huy đụng dashboard nữa.

---

## A. Stripe Connect (khuyên làm TRƯỚC — đây là đường "wow" ví Apple/Google Pay)

### A1. Bật Connect trên account Stripe của Huy
1. Vào https://dashboard.stripe.com/connect/overview
2. Bấm **Get started** → chọn loại **Express** (salon tự onboard, Stripe lo KYC/payout).
3. Điền business profile platform (NailIQ) nếu Stripe hỏi — tên, website `nailiq.ca`, ngành "Software / SaaS".
4. Xong → Connect đã bật. Không cần lấy key gì thêm ở bước này (dùng chung
   `STRIPE_SECRET_KEY` đã có trên Vercel).

> Lưu ý: account hiện đang ở **test mode**. Để nhận tiền thật phải **Activate
> account** (https://dashboard.stripe.com/account/onboarding) — điền thông tin
> doanh nghiệp + tài khoản ngân hàng nhận payout. Có thể test toàn bộ flow ở
> test mode trước, activate sau.

### A2. Verify Apple Pay domain (để nút Apple Pay hiện trên iPhone)
1. Vào https://dashboard.stripe.com/settings/payments/apple_pay
2. Bấm **Add new domain** → nhập `nailiq.ca` (và `www.nailiq.ca` nếu cho add riêng).
3. Stripe đưa 1 file `apple-developer-merchantid-domain-association`.
   → **Gửi file đó cho em** (hoặc nội dung) — em sẽ host tại
   `/.well-known/apple-developer-merchantid-domain-association` trên nailiq.ca.
4. Sau khi em deploy file → Huy bấm **Verify** ở Stripe. Xong → Apple Pay sống.
   (Google Pay không cần bước này — tự chạy khi domain HTTPS.)

### A3. Đưa em cái gì sau khi xong
- Xác nhận "Connect đã Express + đã Activate (hoặc đang test mode)".
- File Apple Pay domain association (bước A2.3).
→ Em sẽ: deploy file well-known, set `payment_provider='stripe'` cho salon test,
  và đổi `StripeProvider` charge dùng `on_behalf_of` + `transfer_data.destination`
  = `stripe_connect_account_id` của salon (route tiền về salon).

---

## B. Square OAuth (cho salon đang dùng Square POS connect 1-bấm)

### B1. Tạo Square application
1. Vào https://developer.squareup.com/apps → **+ Create your first application**
   (hoặc dùng app Square đã có nếu Hi-Lite đang xài).
2. Đặt tên, ví dụ `NailIQ`.
3. Mở app → tab **OAuth**:
   - **Redirect URL**: `https://www.nailiq.ca/api/integrations/square/oauth/callback`
   - Copy **Application ID** và **Application Secret** (cả Sandbox lẫn Production —
     gửi em bản Production để chạy thật).
4. Tab **Credentials**: ghi chú đang ở môi trường **Production**.

### B2. Scopes cần (em set sẵn trong code, Huy chỉ cần app tồn tại)
`MERCHANT_PROFILE_READ PAYMENTS_WRITE PAYMENTS_READ CUSTOMERS_WRITE CUSTOMERS_READ CARDS_WRITE CARDS_READ`

### B3. Đưa em cái gì sau khi xong
- **Square Application ID** (production)
- **Square Application Secret** (production)
→ Em set `SQUARE_OAUTH_CLIENT_ID` / `SQUARE_OAUTH_CLIENT_SECRET` vào Vercel +
  viết route `/api/integrations/square/oauth/{start,callback}` để salon bấm
  "Connect Square" là xong (lưu token vào `square_integrations`).

---

## C. Thứ tự khuyên làm
1. **A1 + A2** (Stripe Connect + Apple Pay) — đường hiện đại nhất, test mode được ngay.
2. Gửi em file Apple Pay → em deploy + nối charge về salon → test full flow trên prod.
3. Khi salon Square thật cần connect → làm **B**.

## D. Việc chỉ Huy làm được (vì là tài khoản/định danh của Huy)
- Bật Stripe Connect + Activate account (KYC, bank payout).
- Add + Verify Apple Pay domain (bấm nút Verify phía Stripe).
- Tạo Square OAuth app + lấy client id/secret.

Mọi thứ còn lại (env, DB, route, deploy, verify) em tự làm.
