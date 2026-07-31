#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION_URL="${VERSION_URL:-https://www.nailiq.ca/api/version}"
HEALTH_URL="${HEALTH_URL:-https://www.nailiq.ca/api/health}"

echo "===== STEP 1: Đăng nhập GH (nếu chưa) ====="
if command -v gh >/dev/null 2>&1; then
  gh auth status || true
else
  echo "⚠️ GitHub CLI chưa cài: bỏ qua kiểm tra auth."
fi

echo "\n===== STEP 2: Migration Resend (preview/apply/verify) ====="
npm run migration:resend-run

echo "\n===== STEP 3: Migration preview lại (để check lại kết quả cuối) ====="
npm run migration:resend-preview

echo "\n===== STEP 4: API /api/version ====="
if curl -sS -m 15 "$VERSION_URL"; then
  :
else
  echo "⚠️ Không gọi được endpoint version: $VERSION_URL"
fi

echo "\n===== STEP 5: API /api/health ====="
if curl -sS -m 15 "$HEALTH_URL"; then
  :
else
  echo "⚠️ Không gọi được endpoint health: $HEALTH_URL"
fi

echo "\n===== STEP 6: Trạng thái local PR target ====="
if git merge-base --is-ancestor 462559d31f0c023a17ca2308719185eba714d772 HEAD; then
  echo "✅ Commit 462559d31f0c023a17ca2308719185eba714d772 đã nằm trên HEAD hiện tại."
else
  echo "⚠️ Commit 462559d31f0c023a17ca2308719185eba714d772 chưa nằm trên HEAD hiện tại."
fi

echo "\n===== HOÀN THÀNH ====="
