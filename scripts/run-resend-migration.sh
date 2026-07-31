#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

printf '===== PREVIEW =====\n'
npm run migration:resend-preview

printf '\n===== APPLY =====\n'
npm run migration:resend-apply

printf '\n===== VERIFY =====\n'
npm run migration:resend-preview

