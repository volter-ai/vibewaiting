#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(process.env.GROK_BUILD_SOURCE_ROOT ?? process.argv[2] ?? "/tmp/xai-grok-build-source");
const fixturePath = resolve(repositoryRoot, "test/fixtures/grok-conformance/native-source-map-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const rows = [...Object.entries(fixture.systems), ...Object.entries(fixture.tools)];

const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
if (sourceRevision !== fixture.sourceRevision) {
  throw new Error(`Native source revision mismatch: expected ${fixture.sourceRevision}, found ${sourceRevision}`);
}

const mappedSourceFiles = new Set();
for (const [key, row] of rows) {
  if (!row.native?.length || !row.browser?.length || !row.tests?.length) {
    throw new Error(`Incomplete source-map evidence for ${key}`);
  }
  for (const sourcePath of row.native) {
    const absolute = resolve(sourceRoot, sourcePath);
    if (!existsSync(absolute)) throw new Error(`Missing native evidence for ${key}: ${sourcePath}`);
    const files = statSync(absolute).isDirectory()
      ? execFileSync("git", ["ls-files", "--", sourcePath], { cwd: sourceRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean)
      : [sourcePath];
    if (files.length === 0) throw new Error(`Native evidence root has no tracked files for ${key}: ${sourcePath}`);
    for (const file of files) mappedSourceFiles.add(file);
  }
  for (const evidencePath of [...row.browser, ...row.tests]) {
    if (!existsSync(resolve(repositoryRoot, evidencePath))) {
      throw new Error(`Missing browser evidence for ${key}: ${evidencePath}`);
    }
  }
}

const hash = createHash("sha256");
const sortedFiles = [...mappedSourceFiles].sort();
for (const sourcePath of sortedFiles) {
  hash.update(sourcePath);
  hash.update("\0");
  hash.update(readFileSync(resolve(sourceRoot, sourcePath)));
  hash.update("\0");
}
const sourceDigest = hash.digest("hex");

if (process.argv.includes("--report")) {
  console.log(JSON.stringify({ sourceFileCount: sortedFiles.length, sourceDigest }, null, 2));
  process.exit(0);
}
if (sortedFiles.length !== fixture.sourceFileCount) {
  throw new Error(`Native source file-count mismatch: expected ${fixture.sourceFileCount}, found ${sortedFiles.length}`);
}
if (sourceDigest !== fixture.sourceDigest) {
  throw new Error(`Native source digest mismatch: expected ${fixture.sourceDigest}, found ${sourceDigest}`);
}

console.log(`Verified ${rows.length} parity rows against ${sortedFiles.length} native source files at ${sourceRevision}.`);
