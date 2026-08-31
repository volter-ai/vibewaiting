import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const crate = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(crate, "../src/generated-codex-wasm");
const rustc = execFileSync("rustup", ["which", "rustc", "--toolchain", "stable"], { encoding: "utf8" }).trim();
const environment = { ...process.env, RUSTC: rustc };

execFileSync("rustup", ["run", "stable", "cargo", "build", "--offline", "--release", "--target", "wasm32-unknown-unknown"], {
  cwd: crate,
  env: environment,
  stdio: "inherit",
});
const metadata = JSON.parse(execFileSync("rustup", ["run", "stable", "cargo", "metadata", "--format-version", "1", "--no-deps"], {
  cwd: crate,
  env: environment,
  encoding: "utf8",
}));
const wasm = path.join(metadata.target_directory, "wasm32-unknown-unknown/release/codex_browser_core_wasm.wasm");
execFileSync("wasm-bindgen", ["--target", "web", "--out-dir", output, "--out-name", "codex_browser_core_wasm", wasm], {
  cwd: crate,
  stdio: "inherit",
});
