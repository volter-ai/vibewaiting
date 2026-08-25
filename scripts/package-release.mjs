#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

execFileSync("npm", ["pack", "--pack-destination", output], {
  cwd: root,
  stdio: "inherit",
});
const extensionArchive = join(output, `vibewaiting-extension-${packageJson.version}.zip`);
execFileSync("zip", ["-q", "-r", extensionArchive, "."], {
  cwd: join(root, "dist/extension"),
  stdio: "inherit",
});

const sbom = execFileSync(
  "npm",
  ["sbom", "--sbom-format", "cyclonedx"],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
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
