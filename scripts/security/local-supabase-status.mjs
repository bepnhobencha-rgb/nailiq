import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const STATUS_TIMEOUT_MS = 20_000;

function normalizedHost(hostname) {
  return hostname.replace(/^\[(.*)\]$/u, "$1");
}

function requireLoopback(url, label) {
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use an explicit loopback hostname`);
  }
  if (!url.port) throw new Error(`${label} must use an explicit local port`);
}

export function canonicalLocalApiUrl(raw, label = "Supabase API URL") {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${label} must use HTTP(S)`);
  }
  requireLoopback(url, label);
  if (url.username || url.password || url.search || url.hash || !new Set(["", "/"]).has(url.pathname)) {
    throw new Error(`${label} must be a credential-free API origin`);
  }
  return `${url.protocol}//${normalizedHost(url.hostname)}:${url.port}`;
}

export function canonicalLocalDatabaseUrl(raw, label = "Supabase DB URL") {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error(`${label} must use PostgreSQL`);
  }
  requireLoopback(url, label);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!url.username || !url.password || !database || new Set(["template0", "template1"]).has(database)) {
    throw new Error(`${label} must contain explicit disposable credentials and a safe database name`);
  }
  if (url.search || url.hash) throw new Error(`${label} must not contain query parameters or fragments`);
  return `postgresql://${normalizedHost(url.hostname)}:${url.port}/${database}`;
}

function requiredStatusString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Supabase status JSON is missing ${field}`);
  }
  return value.trim();
}

export function parseSupabaseStatusJson(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new Error("Supabase status did not return valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase status JSON must be an object");
  }
  return {
    apiUrl: requiredStatusString(value.API_URL, "API_URL"),
    dbUrl: requiredStatusString(value.DB_URL, "DB_URL"),
    anonKey: requiredStatusString(value.ANON_KEY, "ANON_KEY"),
    serviceRoleKey: requiredStatusString(value.SERVICE_ROLE_KEY, "SERVICE_ROLE_KEY"),
  };
}

function secretsEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function assertSupabaseStatusMatches(
  { apiUrl, dbUrl, anonKey, serviceRoleKey },
  status,
  label = "Local Supabase stack",
) {
  if (canonicalLocalApiUrl(apiUrl, `${label} configured API URL`) !==
      canonicalLocalApiUrl(status.apiUrl, `${label} status API_URL`)) {
    throw new Error(`${label} API URL does not match independent Supabase status`);
  }
  if (dbUrl !== undefined &&
      canonicalLocalDatabaseUrl(dbUrl, `${label} configured DB URL`) !==
        canonicalLocalDatabaseUrl(status.dbUrl, `${label} status DB_URL`)) {
    throw new Error(`${label} DB URL does not match independent Supabase status`);
  }
  if (!serviceRoleKey || !secretsEqual(serviceRoleKey, status.serviceRoleKey)) {
    throw new Error(`${label} service-role key does not match independent Supabase status`);
  }
  if (anonKey !== undefined && (!anonKey || !secretsEqual(anonKey, status.anonKey))) {
    throw new Error(`${label} anon key does not match independent Supabase status`);
  }
}

export function sanitizedCommandEnv(source = process.env, extra = {}) {
  return {
    PATH: source.PATH || DEFAULT_PATH,
    LANG: source.LANG || "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    DO_NOT_TRACK: "1",
    SUPABASE_TELEMETRY_DISABLED: "1",
    CI: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_yes: "false",
    ...extra,
  };
}

export function readLocalStackIdentity(rawStackDir, label = "Supabase stack") {
  if (typeof rawStackDir !== "string" || !rawStackDir.trim()) {
    throw new Error(`${label} directory is required`);
  }
  const requestedDir = resolve(rawStackDir.trim());
  let stackDir;
  try {
    stackDir = realpathSync(requestedDir);
  } catch {
    throw new Error(`${label} directory does not exist`);
  }
  if (!statSync(stackDir).isDirectory()) throw new Error(`${label} path must be a directory`);

  const requestedConfig = join(stackDir, "supabase", "config.toml");
  let configPath;
  try {
    if (lstatSync(requestedConfig).isSymbolicLink()) {
      throw new Error(`${label} supabase/config.toml must not be a symlink`);
    }
    configPath = realpathSync(requestedConfig);
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not be a symlink")) throw error;
    throw new Error(`${label} must contain a readable supabase/config.toml`);
  }
  const relativeConfig = relative(stackDir, configPath);
  if (relativeConfig.startsWith("..") || relativeConfig === "") {
    throw new Error(`${label} Supabase config must stay inside the stack directory`);
  }
  if (!statSync(configPath).isFile()) throw new Error(`${label} Supabase config must be a regular file`);

  const config = readFileSync(configPath, "utf8");
  const matches = [...config.matchAll(/^\s*project_id\s*=\s*"([A-Za-z0-9_-]+)"\s*(?:#.*)?$/gmu)];
  if (matches.length !== 1) {
    throw new Error(`${label} Supabase config must contain exactly one simple project_id`);
  }
  const projectId = matches[0][1];
  if (projectId.length > 64) throw new Error(`${label} Supabase project_id is malformed`);
  return { stackDir, configPath, projectId };
}

export function assertDistinctStackIdentities(source, target) {
  if (source.stackDir === target.stackDir) {
    throw new Error("Source and target stack directories must resolve to distinct realpaths");
  }
  if (source.projectId === target.projectId) {
    throw new Error("Source and target Supabase project_id values must be distinct");
  }
}

export function runSupabaseStatus(
  stack,
  { spawn = spawnSync, sourceEnv = process.env, npxBinary = "npx" } = {},
) {
  const result = spawn(
    npxBinary,
    ["--offline", "--yes=false", "supabase", "status", "--output", "json"],
    {
      cwd: stack.stackDir,
      encoding: "utf8",
      env: sanitizedCommandEnv(sourceEnv),
      maxBuffer: 4 * 1024 * 1024,
      timeout: STATUS_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Supabase status failed for project_id ${stack.projectId}`);
  }
  return parseSupabaseStatusJson(result.stdout);
}
