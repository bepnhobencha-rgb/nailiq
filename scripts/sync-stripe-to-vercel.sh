#!/usr/bin/env bash
#
# sync-stripe-to-vercel.sh
# ---------------------------------------------------------------------------
# Đồng bộ Stripe keys từ .env.local (local) → Vercel Production.
# Dùng khi đã verify keys trong .env.local đúng account NailIQ, muốn đẩy lên
# Vercel cho khớp (sửa lỗi publishable mới / secret cũ lệch account).
#
# Cách chạy (tại thư mục gốc repo nailiq):
#     bash scripts/sync-stripe-to-vercel.sh
#
# Yêu cầu: đã `vercel login` + repo đã link (.vercel/project.json tồn tại).
# Secret values đọc từ .env.local TRÊN MÁY BẠN, pipe thẳng vào Vercel CLI —
# không in ra màn hình, không gửi đi đâu khác.
# ---------------------------------------------------------------------------
set -uo pipefail

ENV_FILE=".env.local"
ENVIRONMENTS=("production" "preview")

# Các key Stripe cần đồng bộ
KEYS=(
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
  "STRIPE_PRICE_PRO"
  "STRIPE_PRICE_PREMIUM"
)

GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; DIM="\033[2m"; BOLD="\033[1m"; RESET="\033[0m"

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}✗ Không tìm thấy $ENV_FILE. Chạy script tại thư mục gốc repo nailiq.${RESET}"
  exit 1
fi

# Chọn lệnh vercel (global hoặc npx)
if command -v vercel >/dev/null 2>&1; then
  VERCEL="vercel"
else
  VERCEL="npx vercel"
fi

# Đọc value 1 key từ .env.local (bỏ nháy bao quanh), không in ra
read_val() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 \
    | sed "s/^${key}=//" \
    | sed "s/^[\"']//; s/[\"']$//"
}

echo -e "\n${BOLD}🔄 Đồng bộ Stripe keys → Vercel${RESET}"
echo -e "${DIM}Đọc từ .env.local, đẩy lên: ${ENVIRONMENTS[*]}${RESET}\n"

updated=0
skipped=0

for key in "${KEYS[@]}"; do
  val="$(read_val "$key")"
  if [ -z "$val" ]; then
    echo -e "${YELLOW}⏭  ${key}: trống trong .env.local → bỏ qua${RESET}"
    skipped=$((skipped+1))
    continue
  fi

  # mask để hiển thị an toàn
  masked="${val:0:10}…${val: -4}"
  echo -e "${BOLD}${key}${RESET} ${DIM}(${masked})${RESET}"

  for envname in "${ENVIRONMENTS[@]}"; do
    # Xoá value cũ (nếu có), bỏ qua lỗi nếu chưa tồn tại
    $VERCEL env rm "$key" "$envname" -y >/dev/null 2>&1 || true
    # Thêm value mới qua stdin (không hiện trên màn hình)
    if printf '%s' "$val" | $VERCEL env add "$key" "$envname" >/dev/null 2>&1; then
      echo -e "  ${GREEN}✓ ${envname}${RESET}"
    else
      echo -e "  ${RED}✗ ${envname} (lỗi — kiểm tra vercel login / link project)${RESET}"
    fi
  done
  updated=$((updated+1))
  echo ""
done

echo -e "${GREEN}${BOLD}Xong:${RESET} cập nhật ${updated} key, bỏ qua ${skipped} key trống.\n"
echo -e "${YELLOW}⚠ Cần REDEPLOY để env mới có hiệu lực:${RESET}"
echo -e "    ${BOLD}${VERCEL} --prod${RESET}"
echo -e "${DIM}  (hoặc Vercel Dashboard → Deployments → bản mới nhất → ⋯ → Redeploy)${RESET}\n"
echo -e "${DIM}Nhắc: STRIPE_PRICE_PRO/PREMIUM cần tạo Product trên account NailIQ trước,${RESET}"
echo -e "${DIM}rồi paste price ID vào .env.local và chạy lại script này.${RESET}\n"
