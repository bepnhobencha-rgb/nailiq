#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION_URL="${VERSION_URL:-https://www.nailiq.ca/api/version}"
HEALTH_URL="${HEALTH_URL:-https://www.nailiq.ca/api/health}"

echo "===== RESEND MIGRATION PREVIEW ====="
npm run migration:resend-preview

echo
echo "===== API VERSION ====="
if curl -sS -m 15 "$VERSION_URL"; then
  :
else
  echo "⚠️ Không gọi được version endpoint: $VERSION_URL"
fi

echo
echo "===== API HEALTH ====="
if curl -sS -m 15 "$HEALTH_URL"; then
  :
else
  echo "⚠️ Không gọi được health endpoint: $HEALTH_URL"
fi
