#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(process.env.GROK_BUILD_SOURCE_ROOT ?? process.argv[2] ?? "/tmp/xai-grok-build-source");
const fixturePath = resolve(repositoryRoot, "test/fixtures/grok-conformance/native-control-behaviors-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();

if (sourceRevision !== fixture.sourceRevision) {
  throw new Error(`Native source revision mismatch: expected ${fixture.sourceRevision}, found ${sourceRevision}`);
}

for (const provenance of fixture.provenance) {
  const sourceBytes = readFileSync(resolve(sourceRoot, provenance.path));
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sha256 !== provenance.sha256) {
    throw new Error(`Native source hash mismatch for ${provenance.path}: expected ${provenance.sha256}, found ${sha256}`);
  }
}

console.log(`Verified ${fixture.provenance.length} native source files at ${sourceRevision}.`);
