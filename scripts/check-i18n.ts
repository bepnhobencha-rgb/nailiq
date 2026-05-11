/**
 * i18n & copy linter.
 *
 * Compares parallel locale objects (currently `userEn`/`userVi` from
 * `src/shared/i18n/user/` and the inline `en`/`vi` in
 * `src/shared/i18n/customerWait.ts`) and surfaces:
 *
 *   - keys missing in the other language
 *   - empty values and values that look like the raw key
 *   - common Vietnamese typos and whitespace junk
 *
 * Booking i18n (`src/shared/i18n/booking/`) is intentionally English-only
 * (see the file's leading comment), so it is excluded.
 *
 * Exits 1 if any error-class issue is found; warnings (typos, whitespace)
 * are reported but do not fail the run.
 */
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";

type Locale = Record<string, unknown>;

interface LocalePair {
  name: string;
  en: Locale;
  vi: Locale;
}

interface Issue {
  bundle: string;
  path: string;
  level: "error" | "warning";
  message: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const VI_TYPO_PATTERNS: Array<{ pattern: RegExp; suggestion: string }> = [
  { pattern: /\bkhong\b/gi, suggestion: '"không" (likely missing diacritics)' },
  { pattern: /\bduoc\b/gi, suggestion: '"được" (likely missing diacritics)' },
  { pattern: /\bcua\b/gi, suggestion: '"của" (likely missing diacritics)' },
  { pattern: /\bcam on\b/gi, suggestion: '"cảm ơn"' },
  { pattern: /\btiem\b/gi, suggestion: '"tiệm"' },
  { pattern: /\bhen\b/gi, suggestion: '"hẹn"' },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walkKeys(obj: Locale, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      out.push(...walkKeys(value, path));
    } else if (Array.isArray(value)) {
      value.forEach((_, i) => out.push(`${path}[${i}]`));
    } else {
      out.push(path);
    }
  }
  return out;
}

function getAtPath(obj: Locale, path: string): unknown {
  const segments = path.match(/[^.[\]]+/g) ?? [];
  return segments.reduce<unknown>((acc, segment) => {
    if (isPlainObject(acc)) return acc[segment];
    if (Array.isArray(acc)) {
      const i = Number(segment);
      return Number.isInteger(i) ? acc[i] : undefined;
    }
    return undefined;
  }, obj);
}

function checkValue(
  bundle: string,
  path: string,
  value: unknown,
  lang: "en" | "vi",
): Issue[] {
  const issues: Issue[] = [];

  if (typeof value === "function") return issues;

  if (typeof value !== "string") {
    issues.push({
      bundle,
      path: `${path} [${lang}]`,
      level: "error",
      message: `expected string, got ${typeof value}`,
    });
    return issues;
  }

  if (value.length === 0) {
    issues.push({
      bundle,
      path: `${path} [${lang}]`,
      level: "error",
      message: "empty string",
    });
    return issues;
  }

  const leaf = path.split(".").pop() ?? "";
  if (leaf && value === leaf) {
    issues.push({
      bundle,
      path: `${path} [${lang}]`,
      level: "error",
      message: `value identical to key name "${leaf}" — likely untranslated`,
    });
  }

  if (value !== value.trim()) {
    issues.push({
      bundle,
      path: `${path} [${lang}]`,
      level: "warning",
      message: "leading or trailing whitespace",
    });
  }

  if (/ {2,}/.test(value)) {
    issues.push({
      bundle,
      path: `${path} [${lang}]`,
      level: "warning",
      message: "contains a double space",
    });
  }

  // URL placeholders use ASCII deliberately — skip diacritic checks.
  const looksLikeUrlSample = /https?:\/\//.test(value);
  if (lang === "vi" && !looksLikeUrlSample) {
    for (const { pattern, suggestion } of VI_TYPO_PATTERNS) {
      const m = value.match(pattern);
      if (m) {
        issues.push({
          bundle,
          path: `${path} [vi]`,
          level: "warning",
          message: `possible Vietnamese typo "${m[0]}" — expected ${suggestion}`,
        });
      }
    }
  }

  return issues;
}

function comparePair(pair: LocalePair): Issue[] {
  const issues: Issue[] = [];
  const enKeys = new Set(walkKeys(pair.en));
  const viKeys = new Set(walkKeys(pair.vi));

  for (const k of enKeys) {
    if (!viKeys.has(k)) {
      issues.push({
        bundle: pair.name,
        path: k,
        level: "error",
        message: "present in en, missing in vi",
      });
    }
  }
  for (const k of viKeys) {
    if (!enKeys.has(k)) {
      issues.push({
        bundle: pair.name,
        path: k,
        level: "error",
        message: "present in vi, missing in en",
      });
    }
  }

  const shared = [...enKeys].filter((k) => viKeys.has(k));
  for (const k of shared) {
    issues.push(...checkValue(pair.name, k, getAtPath(pair.en, k), "en"));
    issues.push(...checkValue(pair.name, k, getAtPath(pair.vi, k), "vi"));
  }

  return issues;
}

async function loadLocaleBundles(): Promise<LocalePair[]> {
  const userMod = await import(
    pathToFileURL(resolve(ROOT, "src/shared/i18n/user/index.ts")).href
  );
  const customerWaitMod = await import(
    pathToFileURL(resolve(ROOT, "src/shared/i18n/customerWait.ts")).href
  );

  const userEn = userMod.userEn as Locale;
  const userVi = userMod.userVi as Locale;
  const customerWaitEn = customerWaitMod.getCustomerWaitMessages("en") as Locale;
  const customerWaitVi = customerWaitMod.getCustomerWaitMessages("vi") as Locale;

  return [
    { name: "user", en: userEn, vi: userVi },
    { name: "customerWait", en: customerWaitEn, vi: customerWaitVi },
  ];
}

function formatIssue(issue: Issue): string {
  const tag = issue.level === "error" ? "ERROR" : "warn ";
  return `  [${tag}] ${issue.bundle}.${issue.path} — ${issue.message}`;
}

async function main(): Promise<void> {
  console.log("Checking i18n bundles…\n");
  const bundles = await loadLocaleBundles();
  const allIssues: Issue[] = [];

  for (const pair of bundles) {
    const issues = comparePair(pair);
    allIssues.push(...issues);
    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.filter((i) => i.level === "warning").length;
    const status =
      errors > 0 ? "FAIL" : warnings > 0 ? "warn" : " ok ";
    console.log(
      `[${status}] ${pair.name}: ${errors} error(s), ${warnings} warning(s)`,
    );
    for (const issue of issues) {
      console.log(formatIssue(issue));
    }
    console.log();
  }

  const totalErrors = allIssues.filter((i) => i.level === "error").length;
  const totalWarnings = allIssues.filter((i) => i.level === "warning").length;
  console.log(
    `Summary: ${totalErrors} error(s), ${totalWarnings} warning(s) across ${bundles.length} bundle(s).`,
  );

  if (totalErrors > 0) {
    console.error("\nFailing: at least one error-class issue.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check-i18n crashed:", err);
  process.exit(2);
});
