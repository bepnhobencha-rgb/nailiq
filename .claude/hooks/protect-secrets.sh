#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

if [ "$TOOL_NAME" = "Read" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
  if echo "$FILE_PATH" | grep -iE "\.env|\.pem|\.key|id_rsa|credentials" > /dev/null 2>&1; then
    echo "SECURITY BLOCK: Sensitive file access denied: $FILE_PATH" >&2
    exit 2
  fi
fi

if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
  if echo "$COMMAND" | grep -iE "(^|[[:space:]'\"=/])\.env([^[:alnum:]_]|\$)" > /dev/null 2>&1; then
    echo "SECURITY BLOCK: Command references a .env file" >&2
    exit 2
  fi
fi

exit 0
