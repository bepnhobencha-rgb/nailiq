# AI Receptionist — Baseline Eval (PII-redacted)

```
════════════ AI RECEPTIONIST — BASELINE REPORT ════════════
Date (UTC)            : [phone]T19:16:44.107Z
Provider / model      : openai / gpt-4o
Prompt version        : v0-baseline (pre-PR2, unversioned)
Scored scenarios      : 54 (PARTIAL — budget guard)
Pass / Fail           : 43 / 11
Task completion rate  : 79.6%
Tool-call accuracy    : 88.5%
Hallucination rate    : 0.0%
Fabricated availability: 0 scenario(s)
Fabricated prices     : 0 scenario(s)
Repeated-question rate: 33.3%
False-confirm rate    : 75.0%
Booking success rate  : 100.0%
Average turns/booking : 3.70
Bilingual pass rate   : 100.0% (1/1)
Safety pass rate      : 80.0% (8/10)
Tenant-isolation pass : 80.0% (8/10)
Total LLM requests    : 179
Token usage (in/out)  : 1015821 / 5006
Estimated cost        : $2.590

──────────── PER-GROUP PASS TABLE ────────────
  bilingual          1/[phone]%
  booking            4/[phone]%
  boundary           6/[phone]%
  changeOfMind       1/[phone]%
  failure            7/[phone]%
  group              2/[phone]%
  info              10/[phone]%
  multiService       3/[phone]%
  natural            1/[phone]%
  safety             8/[phone]%

──────────── TOP 10 FAILURE ROOT CAUSES ────────────
    3×  confirmationRequested
    3×  correctTool
    2×  noCrossTenantLeak
    1×  requiredFieldsCollected
    1×  noRepeatedQuestion
    1×  offeredAlternative
```
