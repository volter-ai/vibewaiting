import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
// Persist the selected worktree outside node_modules so `npm ci` cannot silently forget it.
const sourceMarker = join(root, ".vibewaiting/local-agent-source");
const remembered = existsSync(sourceMarker) ? readFileSync(sourceMarker, "utf8").trim() : "";
const requested = (process.argv[2] ?? process.env.SUPERCODE_AGENT_DIR ?? remembered) || undefined;
const candidates = requested
  ? [resolve(requested)]
  : [resolve(root, "../supercode-agent")];
const source = candidates.find((candidate) =>
  existsSync(join(candidate, "sdk/ui/package.json"))
  && existsSync(join(candidate, "sdk/client/package.json"))
  && existsSync(join(candidate, "sdk/typescript/package.json")));

if (!source) {
  throw new Error("Local Supercode Agent checkout not found. Pass its root directory or set SUPERCODE_AGENT_DIR.");
}

const fleet = process.env.SUPERCODE_FLEET_DIR && resolve(process.env.SUPERCODE_FLEET_DIR);
if (!fleet || !existsSync(join(fleet, "sdk/typescript/package.json"))) {
  throw new Error("Set SUPERCODE_FLEET_DIR to the Fleet source checkout used by this Agent build.");
}

const packages = [
  [join(source, "sdk/interchange"), "@volter/supercode-agent-runtime"],
  [join(source, "sdk/typescript"), "@volter/supercode-agent-sdk"],
  [join(source, "sdk/client"), "@volter/supercode-agent-client"],
  [join(source, "sdk/frontend"), "@volter/supercode-agent-frontend"],
  [join(source, "sdk/orchestrator"), "@volter/supercode-agent-orchestrator"],
  [join(source, "sdk/ui"), "@volter/supercode-agent-ui"],
  [join(source, "sdk/remote-access"), "@volter/supercode-agent-remote-access"],
  [join(source, "sdk/terminal"), "@volter/supercode-agent-terminal"],
  [join(source, "packaging/npm"), "@volter/supercode-agent"],
];
const nativePackages = new Map();
for (const directory of [
  ...readdirSync(join(fleet, "sdk"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(fleet, "sdk", entry.name)),
  join(fleet, "sources/identity/packages/identity"),
  join(fleet, "sources/ztrack"),
  join(fleet, "sources/tunnel"),
  join(fleet, "sources/tunnel/packages/core"),
]) {
  const manifest = join(directory, "package.json");
  if (existsSync(manifest)) nativePackages.set(JSON.parse(readFileSync(manifest, "utf8")).name, directory);
}
const selected = new Set(packages.map(([, name]) => name));
for (let index = 0; index < packages.length; index += 1) {
  const manifest = JSON.parse(readFileSync(join(packages[index][0], "package.json"), "utf8"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (selected.has(name)) continue;
    const directory = nativePackages.get(name);
    if (!directory) {
      if (name.startsWith("@volter/supercode") || name === "@volter/teams" || name === "@volter/identity") {
        throw new Error(`The selected Fleet source does not contain ${name}, required by ${manifest.name}.`);
      }
      continue;
    }
    packages.push([directory, name]);
    selected.add(name);
  }
}
const lucarneSource = resolve(process.env.LUCARNE_DIR ?? join(root, "../lucarne"));
const syncLocalSurfaces =
  process.env.VIBEWAITING_LOCAL_SURFACES === "1" &&
  process.env.VIBEWAITING_AGENT_ONLY !== "1";
if (syncLocalSurfaces && existsSync(join(lucarneSource, "packages/lucarne/package.json"))) {
  packages.push([join(lucarneSource, "packages/lucarne"), "@volter/lucarne"]);
}
const widgetShellSource = resolve(process.env.WIDGET_SHELL_DIR ?? join(root, "../widget-shell"));
if (syncLocalSurfaces && existsSync(join(widgetShellSource, "package.json"))) {
  packages.push([widgetShellSource, "@volter/widget-shell"]);
}
const termfleetRoot = resolve(process.env.TERMFLEET_DIR ?? join(root, "../termfleet"));
const termfleetTerminalSource = join(termfleetRoot, "packages/terminal");
if (existsSync(join(termfleetTerminalSource, "src/native-host.ts"))) {
  packages.push([termfleetTerminalSource, "@termfleet/terminal"]);
}

function run(program, args, options) {
  const inheritedEnv = options?.env ?? process.env;
  const result = spawnSync(program, args, {
    stdio: "inherit",
    ...options,
    env: {
      ...inheritedEnv,
      PATH: `${join(root, "node_modules/.bin")}${delimiter}${inheritedEnv.PATH ?? ""}`,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status ?? "without a status"}`);
}

function packPackage(packageRoot, expectedName, scratch) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(`${packageRoot} is ${manifest.name ?? "an unnamed package"}, not ${expectedName}`);
  }
  run("pnpm", ["pack", "--ignore-scripts", "--pack-destination", scratch], { cwd: packageRoot });
  const filename = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
  return { name: expectedName, version: manifest.version, artifact: join(scratch, filename) };
}

const startedAt = performance.now();
const binary = resolve(process.env.SUPERCODE_CODING_BIN ?? join(source, "packaging/npm/bin/supercode-agent.js"));
if (!existsSync(binary)) throw new Error(`Supercode Agent entry does not exist: ${binary}`);
for (const name of ["@volter/identity", "@volter/ztrack", "@volter/supercode-terminal"]) {
  if (!selected.has(name)) continue;
  const directory = nativePackages.get(name);
  if (name === "@volter/identity") run("pnpm", ["run", "build"], { cwd: directory });
  if (name === "@volter/ztrack") {
    run("pnpm", ["run", "build:brand-tokens"], { cwd: directory });
    run("pnpm", ["run", "build:node-cli"], { cwd: directory });
  }
  if (name === "@volter/supercode-terminal") run("pnpm", ["run", "build:substrate"], { cwd: directory });
}
run("pnpm", ["run", "build"], { cwd: join(source, "sdk/ui") });
run("pnpm", ["run", "build"], { cwd: join(source, "sdk/terminal") });
if (packages.some(([, name]) => name === "@volter/lucarne")) {
  run("npm", ["run", "build"], { cwd: join(lucarneSource, "packages/lucarne") });
}
if (packages.some(([, name]) => name === "@volter/widget-shell")) {
  if (existsSync(join(widgetShellSource, "node_modules/.bin/tsup"))) {
    run("npm", ["run", "build"], { cwd: widgetShellSource });
  } else if (existsSync(join(widgetShellSource, "dist/index.js"))) {
    process.stdout.write("local Widget Shell build dependencies are absent; reusing its existing dist\n");
  } else {
    throw new Error("Local Widget Shell has no dist and cannot build. Run npm install in its checkout.");
  }
}
if (packages.some(([, name]) => name === "@termfleet/terminal")) {
  run("npm", ["run", "build"], { cwd: termfleetTerminalSource });
}

const scratch = mkdtempSync(join(tmpdir(), "vibewaiting-agent-"));
try {
  const installed = packages.map(([packageRoot, name]) => packPackage(packageRoot, name, scratch));
  run("npm", ["install", "--no-save", "--package-lock=false", ...installed.map(pkg => pkg.artifact)], { cwd: root });
  const marker = join(root, "node_modules/.cache/vibewaiting/local-agent-bin");
  mkdirSync(resolve(marker, ".."), { recursive: true });
  mkdirSync(resolve(sourceMarker, ".."), { recursive: true });
  const writeChanged = (path, value) => {
    if (!existsSync(path) || readFileSync(path, "utf8") !== value) writeFileSync(path, value, "utf8");
  };
  writeChanged(marker, `${binary}\n`);
  writeChanged(sourceMarker, `${source}\n`);
  process.stdout.write(
    `local Supercode Agent stack synced from ${source}, Fleet from ${fleet}, in ${Math.round(performance.now() - startedAt)}ms\n`
      + installed.map(({ name, version }) => `  ${name}@${version}`).join("\n") + "\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
