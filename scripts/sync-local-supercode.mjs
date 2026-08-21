import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2] ?? process.env.SUPERCODE_DIR;
const candidates = requested
  ? [resolve(requested)]
  : [resolve(root, "../supercode-live-cc"), resolve(root, "../supercode")];
const source = candidates.find((candidate) =>
  existsSync(join(candidate, "sdk/ui/package.json"))
  && existsSync(join(candidate, "sdk/client/package.json"))
  && existsSync(join(candidate, "sdk/typescript/package.json")));

if (!source) {
  throw new Error("Local Supercode checkout not found. Pass its root directory or set SUPERCODE_DIR.");
}

const packages = [
  [join(source, "sdk/typescript"), "@volter-ai-dev/supercode-harness-sdk"],
  [join(source, "sdk/client"), "@volter-ai-dev/supercode-client"],
  [join(source, "sdk/ui"), "@volter-ai-dev/supercode-ui"],
];
const lucarneSource = resolve(process.env.LUCARNE_DIR ?? join(root, "../lucarne"));
if (existsSync(join(lucarneSource, "packages/lucarne/package.json"))) {
  packages.push([join(lucarneSource, "packages/lucarne"), "lucarne"]);
}
const widgetShellSource = resolve(process.env.WIDGET_SHELL_DIR ?? join(root, "../widget-shell"));
if (existsSync(join(widgetShellSource, "package.json"))) {
  packages.push([widgetShellSource, "@volter-ai-dev/widget-shell"]);
}

function run(program, args, options) {
  const result = spawnSync(program, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status ?? "without a status"}`);
}

function installPackage(packageRoot, expectedName, scratch) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(`${packageRoot} is ${manifest.name ?? "an unnamed package"}, not ${expectedName}`);
  }
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
  });
  if (pack.error) throw pack.error;
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr);
    throw new Error(`npm pack for ${expectedName} exited ${pack.status ?? "without a status"}`);
  }
  const [{ filename }] = JSON.parse(pack.stdout);
  const target = join(root, "node_modules", expectedName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", join(scratch, filename), "--strip-components=1", "-C", target]);
  return manifest.version;
}

function latestRustInputMtime(sourceRoot) {
  let latest = Math.max(statSync(join(sourceRoot, "Cargo.toml")).mtimeMs, statSync(join(sourceRoot, "Cargo.lock")).mtimeMs);
  const pending = [join(sourceRoot, "crates")];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.name === "Cargo.toml" || entry.name.endsWith(".rs")) {
        latest = Math.max(latest, statSync(path).mtimeMs);
      }
    }
  }
  return latest;
}

const startedAt = performance.now();
const binary = resolve(process.env.SUPERCODE_BINARY ?? join(source, "target/debug/supercode"));
if (!process.env.SUPERCODE_BINARY && (!existsSync(binary) || statSync(binary).mtimeMs < latestRustInputMtime(source))) {
  run("cargo", ["build", "-p", "supercode-cli", "--bin", "supercode"], { cwd: source });
} else if (process.env.SUPERCODE_BINARY && !existsSync(binary)) {
  throw new Error(`SUPERCODE_BINARY does not exist: ${binary}`);
} else {
  process.stdout.write("local Supercode binary is current; skipping Rust rebuild\n");
}
run("npm", ["run", "build"], { cwd: join(source, "sdk/ui") });
if (packages.some(([, name]) => name === "lucarne")) {
  run("npm", ["run", "build"], { cwd: join(lucarneSource, "packages/lucarne") });
}
if (packages.some(([, name]) => name === "@volter-ai-dev/widget-shell")) {
  run("npm", ["run", "build"], { cwd: widgetShellSource });
}

const scratch = mkdtempSync(join(tmpdir(), "vibewaiting-supercode-"));
try {
  const installed = packages.map(([packageRoot, name]) => [
    name,
    installPackage(packageRoot, name, scratch),
  ]);
  const marker = join(root, "node_modules/.cache/vibewaiting/local-supercode-bin");
  mkdirSync(resolve(marker, ".."), { recursive: true });
  writeFileSync(marker, `${binary}\n`, "utf8");
  process.stdout.write(
    `local Supercode stack synced from ${source} in ${Math.round(performance.now() - startedAt)}ms\n`
      + installed.map(([name, version]) => `  ${name}@${version}`).join("\n") + "\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
