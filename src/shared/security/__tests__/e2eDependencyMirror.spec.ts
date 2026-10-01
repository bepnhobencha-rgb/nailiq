import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/e2e.yml"), "utf8");
const stepName = "Prefer official Ubuntu archive for non-RC browser dependencies";
const official = "https://archive.ubuntu.com/ubuntu/";
const azure = "http://azure.archive.ubuntu.com/ubuntu/";
const security = "https://security.ubuntu.com/ubuntu/\tpriority:3\n";
const original = `${azure}\tpriority:1\n${official}\tpriority:2\n${security}`;
const preferred = `${azure}\tpriority:2\n${official}\tpriority:1\n${security}`;

function mirrorStep() {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  const end = workflow.indexOf("      - name: Install Playwright browsers", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function transform(input: string) {
  const step = mirrorStep();
  const program = step.match(/awk '([\s\S]*?)'\s+"\$mirror_file"/);
  expect(program).not.toBeNull();
  return spawnSync("awk", [program![1]], { input, encoding: "utf8" });
}

describe("non-RC browser dependency setup and timeout evidence", () => {
  it("prepares the mirror only for the configured non-RC disposable runner before installation", () => {
    const step = mirrorStep();
    expect(step).toContain("steps.preflight.outputs.configured == 'true' && matrix.shard == 1");
    expect(step).toContain('test "${GITHUB_ACTIONS:-}" = "true"');
    expect(step).toContain('test "${RUNNER_OS:-}" = "Linux"');
    expect(step).toContain('test "${RUNNER_ARCH:-}" = "X64"');
    expect(step).toContain('test "${RUNNER_ENVIRONMENT:-}" = "github-hosted"');
  });

  it("prefers the canonical HTTPS archive while retaining Azure and security fallback entries", () => {
    const result = transform(original);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(preferred);
  });

  it("is idempotent when the official archive is already preferred", () => {
    const once = transform(original);
    const twice = transform(once.stdout);
    expect(twice.status).toBe(0);
    expect(twice.stdout).toBe(once.stdout);
  });

  it("preserves comments, blank lines and unrelated mirror entries exactly", () => {
    const suffix = "\n# unrelated mirror\nhttps://example.invalid/ubuntu/ priority:9\n";
    const result = transform(`# Ubuntu archives\n${original}${suffix}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`# Ubuntu archives\n${preferred}${suffix}`);
  });

  it("accepts the existing HTTPS Azure spelling without downgrading transport", () => {
    const input = original.replace(azure, "https://azure.archive.ubuntu.com/ubuntu/");
    const result = transform(input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(preferred.replace(azure, "https://azure.archive.ubuntu.com/ubuntu/"));
  });

  it("keeps an unrelated lower-priority fallback without competing with the preferred archive", () => {
    const suffix = "https://example.invalid/ubuntu/ priority:2\n";
    const result = transform(original + suffix);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(preferred + suffix);
  });

  it.each([" ", "\t", "    "])("handles upstream field whitespace %j", (separator) => {
    const result = transform(original.replaceAll("\t", separator));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${official}\tpriority:1\n`);
    expect(result.stdout).toContain(`${azure}\tpriority:2\n`);
    expect(result.stdout).toContain(security.replaceAll("\t", separator));
  });

  it.each([
    ["missing canonical archive", `${azure}\tpriority:1\n${security}`],
    ["missing Azure entry", `${official}\tpriority:2\n${security}`],
    ["duplicate canonical archive", `${original}${official}\tpriority:2\n`],
    ["duplicate Azure entry", `${original}${azure}\tpriority:1\n`],
    ["unexpected archive priority", original.replace(`${official}\tpriority:2`, `${official}\tpriority:0`)],
    ["unexpected Azure priority", original.replace(`${azure}\tpriority:1`, `${azure}\tpriority:0`)],
    ["extra canonical options", original.replace(`${official}\tpriority:2`, `${official}\tpriority:2 extra:1`)],
    ["extra Azure options", original.replace(`${azure}\tpriority:1`, `${azure}\tpriority:1 extra:1`)],
    ["lookalike canonical host", original.replace(official, "https://archive.ubuntu.com.evil.invalid/ubuntu/")],
    ["HTTP canonical archive", original.replace(official, "http://archive.ubuntu.com/ubuntu/")],
    ["competing priority 1", original + "https://example.invalid/ubuntu/ priority:1\n"],
    ["competing priority 0", original + "https://example.invalid/ubuntu/ priority:0\n"],
    ["implicit competing priority", original + "https://example.invalid/ubuntu/\n"],
    ["empty input", ""],
  ])("fails closed before installation for %s", (_name, input) => {
    expect(transform(input).status).toBe(42);
  });

  it("stages the transformation before one explicit install and never changes signing or apt source files", () => {
    const step = mirrorStep();
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("mirror_file=/etc/apt/apt-mirrors.txt");
    expect(step).toContain('mktemp -d "${RUNNER_TEMP}/nailiq-apt-mirror.XXXXXX"');
    expect(step).toContain('cp -- "$mirror_file" "${mirror_dir}/original.txt"');
    expect(step.indexOf("awk '")).toBeLessThan(step.indexOf("sudo install"));
    expect(step).toContain('sudo install -m 0644 -- "${mirror_dir}/apt-mirrors.txt" "$mirror_file"');
    expect(step).not.toMatch(/apt-key|trusted=yes|allow-unauthenticated|AllowInsecure|sources\.list|ubuntu\.sources|\|\| true|continue-on-error/);
  });

  it("parses as a complete Bash script without executing privileged operations", () => {
    const script = mirrorStep().split("        run: |\n")[1];
    expect(script).toBeDefined();
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  });

  it.each([
    ["not GitHub Actions", { GITHUB_ACTIONS: "false", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted" }],
    ["not Linux", { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted" }],
    ["not X64", { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", RUNNER_ENVIRONMENT: "github-hosted" }],
    ["self-hosted", { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "self-hosted" }],
  ])("rejects %s before any filesystem or privileged operation", (_name, environment) => {
    const step = mirrorStep();
    const script = step.split("        run: |\n")[1];
    expect(script).toBeDefined();
    const guards = script.split("          mirror_file=")[0];
    const result = spawnSync("bash", ["-c", guards], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", ...environment }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  });

  it("preserves the primary report before all long WebKit diagnostics", () => {
    const primary = workflow.indexOf("      - name: Run E2E tests");
    const receipt = workflow.indexOf("      - name: Preserve primary non-RC evidence before WebKit diagnostics");
    const diagnostic = workflow.indexOf("      - name: Run Guided Setup mobile certification");
    expect(receipt).toBeGreaterThan(primary);
    expect(receipt).toBeLessThan(diagnostic);
    const step = workflow.slice(receipt, diagnostic);
    expect(step).toContain("always() && steps.preflight.outputs.configured == 'true' && matrix.shard == 1");
    expect(step).toContain("uses: actions/upload-artifact@v7");
    expect(step).toContain("name: playwright-primary-report-shard-1");
    expect(step).toContain("playwright-report/");
    expect(step).toContain("tmp/next-server.log");
    expect(step).toContain("retention-days: 14");
  });

  it("keeps the existing timeout, browser repetitions, provider suppression and disposable cleanup", () => {
    expect(workflow).toContain("timeout-minutes: 45");
    expect(workflow).toContain("npx playwright install --with-deps ${{ steps.projects.outputs.browsers }}");
    expect(workflow).toContain("--project=mobile --repeat-each=10 --retries=0 --reporter=list,html,json");
    expect(workflow).toContain("--project=mobile --repeat-each=3 --retries=0 --reporter=list,html,json");
    expect(workflow).toContain('DISABLE_OUTBOUND_SMS: "1"');
    expect(workflow).toContain('DISABLE_OUTBOUND_CALLS: "1"');
    expect(workflow).toContain('TWILIO_AUTH_TOKEN: ""');
    expect(workflow).toContain('RESEND_API_KEY: ""');
    expect(workflow).toContain('STRIPE_SECRET_KEY: ""');
    expect(workflow).toContain("supabase stop --no-backup");
  });
});
