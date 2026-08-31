#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "release");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
const expectedTag = `v${packageJson.version}`;

if (manifest.version !== packageJson.version)
  throw new Error(
    `package version ${packageJson.version} does not match extension version ${manifest.version}`,
  );
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== expectedTag)
  throw new Error(`release tag must be ${expectedTag}, not ${process.env.GITHUB_REF_NAME}`);
if (process.env.GITHUB_REF_TYPE === "tag") {
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## \\[${packageJson.version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog))
    throw new Error(`CHANGELOG.md must contain a dated ${packageJson.version} release before tagging`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

execFileSync("npm", ["pack", "--pack-destination", output], {
  cwd: root,
  stdio: "inherit",
});
const packageArchive = join(output, `${packageJson.name}-${packageJson.version}.tgz`);
const extensionArchive = join(output, `vibewaiting-extension-${packageJson.version}.zip`);
execFileSync("zip", ["-q", "-r", extensionArchive, "."], {
  cwd: join(root, "dist/extension"),
  stdio: "inherit",
});

const sbomStage = await mkdtemp(join(tmpdir(), "vibewaiting-sbom-"));
let sbom;
try {
  execFileSync("tar", ["-xzf", packageArchive, "-C", sbomStage]);
  const stagedRoot = join(sbomStage, "package");
  await verifyThirdPartyNotices(stagedRoot);
  const stagedManifestPath = join(stagedRoot, "package.json");
  const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"));
  delete stagedManifest.devDependencies;
  await writeFile(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  sbom = execFileSync(
    "npm",
    ["sbom", "--sbom-format", "cyclonedx"],
    { cwd: stagedRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
} finally {
  await rm(sbomStage, { recursive: true, force: true });
}
await writeFile(
  join(output, `vibewaiting-${packageJson.version}.sbom.json`),
  sbom,
  "utf8",
);

const files = (await readdir(output)).filter((name) => name !== "SHA256SUMS").sort();
const sums = [];
for (const name of files) {
  const bytes = await readFile(join(output, name));
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${basename(name)}`);
}
await writeFile(join(output, "SHA256SUMS"), `${sums.join("\n")}\n`, "utf8");

process.stdout.write(`release artifacts → ${output}\n  ${files.join("\n  ")}\n  SHA256SUMS\n`);

async function verifyThirdPartyNotices(stagedRoot) {
  const notices = await readFile(join(stagedRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const declared = new Map();
  for (const line of notices.split("\n")) {
    const match = line.match(/^\| `([^`]+)` \| ([^| ]+) \|/);
    if (match) declared.set(match[1], match[2]);
  }
  const bundled = new Map();
  await visitNodeModules(join(stagedRoot, "node_modules"), bundled);
  const problems = [];
  for (const [name, version] of bundled) {
    if (!declared.has(name)) problems.push(`missing notice for ${name}@${version}`);
    else if (declared.get(name) !== version)
      problems.push(`notice says ${name}@${declared.get(name)}; bundle contains ${version}`);
  }
  for (const [name, version] of declared)
    if (!bundled.has(name)) problems.push(`notice lists unbundled ${name}@${version}`);
  if (problems.length)
    throw new Error(`THIRD_PARTY_NOTICES.md does not match the packed runtime:\n${problems.join("\n")}`);
}

async function visitNodeModules(directory, packages) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scope = join(directory, entry.name);
      for (const child of await readdir(scope, { withFileTypes: true }))
        if (child.isDirectory()) await recordPackage(join(scope, child.name), packages);
      continue;
    }
    await recordPackage(join(directory, entry.name), packages);
  }
}

async function recordPackage(directory, packages) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (typeof manifest?.name === "string" && typeof manifest.version === "string")
    packages.set(manifest.name, manifest.version);
  await visitNodeModules(join(directory, "node_modules"), packages);
}
