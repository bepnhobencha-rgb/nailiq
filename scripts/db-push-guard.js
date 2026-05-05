#!/usr/bin/env node

console.error(
  [
    "",
    "  BLOCKED: supabase db push is disabled.",
    "",
    "  The remote migration tracking table is out of sync with",
    "  local migration files. Running db push now would attempt",
    "  to re-execute SQL for objects that already exist on prod.",
    "",
    '  See docs/decisions.md -> "Migration tracking out of sync"',
    "  for the full reconcile plan.",
    "",
  ].join("\n"),
);

process.exit(1);
