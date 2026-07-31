#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENVIRONMENT="${ENVIRONMENT:-production}"
VERSION_URL="${VERSION_URL:-https://www.nailiq.ca/api/version}"
HEALTH_URL="${HEALTH_URL:-https://www.nailiq.ca/api/health}"

if [[ "${FORCE_APPLY:-}" != "1" ]]; then
  echo "⚠️ Script này thực thi apply cho migration resend."
  echo "⚠️ Chỉ chạy khi bạn đã chắc chắn môi trường là đúng."
  echo "   Nếu đồng ý, chạy lại với FORCE_APPLY=1"
  exit 2
fi

echo "===== STEP 1: PREVIEW ====="
npm run migration:resend-preview

echo
echo "===== STEP 2: APPLY ====="
npm run migration:resend-apply -- --json --fail-if-remaining

echo
echo "===== STEP 3: VERIFY ====="
npm run migration:resend-preview

echo
echo "===== STEP 4: VERSION ====="
if curl -sS -m 15 "$VERSION_URL"; then
  :
else
  echo "⚠️ Không thể gọi $VERSION_URL (bỏ qua, tiếp tục kiểm tra health)"
fi

echo
echo "===== STEP 5: HEALTH ====="
if curl -sS -m 15 "$HEALTH_URL" >/dev/null 2>&1; then
  curl -sS -m 15 "$HEALTH_URL"
else
  echo "⚠️ Không thể gọi $HEALTH_URL"
fi

echo
echo "===== HOÀN TẤT ====="
