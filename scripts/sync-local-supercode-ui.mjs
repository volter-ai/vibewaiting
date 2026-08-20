import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2] ?? process.env.SUPERCODE_UI_DIR;
const candidates = requested
  ? [resolve(requested)]
  : [resolve(root, "../supercode/sdk/ui"), resolve(root, "../supercode-live-cc/sdk/ui")];
const source = candidates.find((candidate) => existsSync(join(candidate, "package.json")));

if (!source) {
  throw new Error("Local Supercode UI not found. Pass its directory or set SUPERCODE_UI_DIR.");
}

const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
if (manifest.name !== "@volter-ai-dev/supercode-ui") {
  throw new Error(`${source} is ${manifest.name ?? "an unnamed package"}, not @volter-ai-dev/supercode-ui`);
}

const startedAt = performance.now();
const build = spawnSync("npm", ["run", "build"], { cwd: source, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Local Supercode UI build exited ${build.status ?? "without a status"}`);

const scratch = mkdtempSync(join(tmpdir(), "vibewaiting-supercode-ui-"));
try {
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
    cwd: source,
    encoding: "utf8",
  });
  if (pack.error) throw pack.error;
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr);
    throw new Error(`Local Supercode UI pack exited ${pack.status ?? "without a status"}`);
  }
  const [{ filename }] = JSON.parse(pack.stdout);
  const target = join(root, "node_modules/@volter-ai-dev/supercode-ui");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", join(scratch, filename), "--strip-components=1", "-C", target], { stdio: "inherit" });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`Local Supercode UI extraction exited ${extract.status ?? "without a status"}`);
  process.stdout.write(`local Supercode UI ${manifest.version} synced in ${Math.round(performance.now() - startedAt)}ms\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
