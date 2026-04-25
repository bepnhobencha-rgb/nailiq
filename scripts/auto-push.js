/**
 * Auto commit + push after debounced file changes (dev safe mode).
 * Watches the repo; ignores .next, node_modules, .git, logs.
 */

const { execSync } = require("child_process");
const path = require("path");
const chokidar = require("chokidar");

const DEBOUNCE_MS = 30_000;
const ROOT = path.resolve(__dirname, "..");

let debounceTimer = null;
let isPushing = false;
let pendingReschedule = false;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/**
 * @returns {string[]}
 */
function getChangedPathsFromStatus() {
  try {
    const out = execSync("git status --porcelain", {
      encoding: "utf8",
      cwd: ROOT,
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        if (line.length < 4) return line.trim();
        const rest = line.slice(3).trim();
        if (rest.includes(" -> ")) {
          return rest.split(" -> ").pop().trim();
        }
        return rest;
      });
  } catch {
    return [];
  }
}

function hasUncommittedChanges() {
  return getChangedPathsFromStatus().length > 0;
}

/**
 * Short commit message from changed paths; fallback to "auto update".
 * @param {string[]} paths
 */
function inferCommitMessage(paths) {
  if (paths.length === 0) return "auto update";

  const joined = paths.join(" ").toLowerCase();

  if (
    joined.includes("globals.css") ||
    joined.includes("theme/tokens") ||
    joined.includes("tailwind")
  ) {
    return "update styles";
  }
  if (
    joined.includes("marketinghome") ||
    joined.includes("components/user") ||
    joined.includes("shared/i18n/user") ||
    joined.includes("app/page")
  ) {
    return "update landing UI";
  }
  if (joined.includes("i18n") || joined.includes("messages")) {
    return "update copy and i18n";
  }
  if (
    joined.includes("components/layout") ||
    joined.includes("responsiveshell") ||
    joined.includes("mobilestack") ||
    joined.includes("desktopsplit")
  ) {
    return "update layout";
  }
  if (joined.includes("seo/") || joined.includes("sitemap") || joined.includes("robots")) {
    return "update SEO";
  }
  if (paths.length === 1) {
    const base = path.basename(paths[0] || "");
    if (base) return `update ${base.replace(/\.[^.]+$/, "")}`;
  }
  return "auto update";
}

function doPush() {
  if (isPushing) {
    pendingReschedule = true;
    return;
  }

  if (!hasUncommittedChanges()) {
    return;
  }

  isPushing = true;
  try {
    const pathsBefore = getChangedPathsFromStatus();
    const message = inferCommitMessage(pathsBefore);

    log("Auto pushing...");
    execSync("git add .", { stdio: "inherit", cwd: ROOT });
    if (!hasUncommittedChanges()) {
      return;
    }
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      stdio: "inherit",
      cwd: ROOT,
    });
    execSync("git push", { stdio: "inherit", cwd: ROOT });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err?.message || err);
  } finally {
    isPushing = false;
    if (pendingReschedule) {
      pendingReschedule = false;
      schedule();
    }
  }
}

function schedule() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    doPush();
  }, DEBOUNCE_MS);
}

const watcher = chokidar.watch(ROOT, {
  ignored: [
    /(^|[/\\])\.next($|[/\\])/,
    /(^|[/\\])node_modules($|[/\\])/,
    /(^|[/\\])\.git($|[/\\])/,
    /(^|[/\\])logs($|[/\\])/,
  ],
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

watcher.on("all", (event, filePath) => {
  if (event !== "add" && event !== "addDir" && event !== "change" && event !== "unlink" && event !== "unlinkDir") {
    return;
  }
  log("Changes detected...");
  schedule();
});

watcher
  .on("ready", () => {
    log("Watching changes...");
  })
  .on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("Watcher error:", err);
  });
