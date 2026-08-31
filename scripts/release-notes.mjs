#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const tag = process.argv[2] ?? "";
const version = tag.startsWith("v") ? tag.slice(1) : tag;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/release-notes.mjs vX.Y.Z");
}

const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = `## [${version}]`;
const headingStart = changelog.indexOf(heading);
const contentStart = headingStart < 0 ? -1 : changelog.indexOf("\n", headingStart) + 1;
const remainder = contentStart > 0 ? changelog.slice(contentStart) : "";
const boundaries = [remainder.search(/^## \[/m), remainder.search(/^\[[^\]]+\]:/m)]
  .filter((index) => index >= 0);
const contentEnd = boundaries.length ? Math.min(...boundaries) : remainder.length;
const releaseChanges = remainder.slice(0, contentEnd).trim();
if (!releaseChanges) {
  throw new Error(`CHANGELOG.md has no release section for ${version}`);
}
const releaseUrl = `https://github.com/volter-ai/vibewaiting/releases/download/v${version}`;
process.stdout.write(`> **Public alpha.** Vibewaiting currently supports macOS or Linux,
> Chrome/Chromium/Brave, and local Claude Code or Codex sessions.

Vibewaiting puts your local coding-agent sessions in a compact browser messenger. Follow
live work, reply without changing windows, attach the page you are reviewing, switch the
same conversation into a tmux-backed terminal, or pair a phone for optional remote access.

${releaseChanges}

## Install

Download \`vibewaiting-${version}.tgz\` and \`SHA256SUMS\` below, verify the checksum,
then run:

\`\`\`sh
npm install --global ./vibewaiting-${version}.tgz
vibewaiting native install --browser chrome
\`\`\`

Use \`--browser brave\` or \`--browser chromium\` when appropriate. Until the signed
store listing is available, load the durable extension folder printed by the installer
once from the browser's extensions page.

## Verify the supply chain

Every downloadable artifact has a checksum, CycloneDX SBOM, and public GitHub build
provenance:

\`\`\`sh
# macOS
shasum -a 256 --check SHA256SUMS
# Linux
sha256sum --check SHA256SUMS
gh attestation verify vibewaiting-${version}.tgz --repo volter-ai/vibewaiting
gh attestation verify vibewaiting-extension-${version}.zip --repo volter-ai/vibewaiting
\`\`\`

Read the [install guide](https://github.com/volter-ai/vibewaiting/blob/v${version}/docs/install.md),
[privacy policy](https://github.com/volter-ai/vibewaiting/blob/v${version}/PRIVACY.md), and
[security model](https://github.com/volter-ai/vibewaiting/blob/v${version}/SECURITY.md)
before granting optional website access. Direct artifact base: ${releaseUrl}.
`);
