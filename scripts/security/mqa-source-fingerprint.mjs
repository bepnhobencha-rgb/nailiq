#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const root = process.cwd();
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
);
const paths = listed
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, "en"));

const hash = createHash("sha256");
for (const path of paths) {
  const stat = lstatSync(path);
  const content = stat.isSymbolicLink()
    ? Buffer.from(readlinkSync(path), "utf8")
    : readFileSync(path);
  hash.update(`${path.length}:`);
  hash.update(path, "utf8");
  hash.update(`:${stat.isSymbolicLink() ? "link" : "file"}:${content.length}:`);
  hash.update(content);
  hash.update("\0");
}

process.stdout.write(`${hash.digest("hex")}\n`);
