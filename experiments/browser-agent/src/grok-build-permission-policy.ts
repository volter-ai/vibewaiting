// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

/** Result of native Ask-mode Bash segment scrutiny. */
export interface GrokBuildBashPermissionAnalysis {
  segments: readonly string[];
  needsPrompt: readonly string[];
  dangerous: readonly string[];
  parseable: boolean;
}

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "branch", "log", "diff", "ls-files", "show", "rev-parse", "blame", "grep",
  "describe", "merge-base", "check-ignore", "check-attr", "cat-file", "ls-tree", "show-ref",
  "for-each-ref", "rev-list", "name-rev", "count-objects", "shortlog",
]);
const GIT_QUERY_UNSAFE_OPTIONS = ["--filters", "--textconv", "--output", "--ext-diff", "--open-files-in-pager"];
const KUBECTL_UNSAFE_FLAGS = new Set([
  "--kubeconfig", "--context", "--cluster", "--server", "-s", "--token", "--user", "--as",
  "--as-group", "--as-uid", "--as-user-extra", "--username", "--password",
  "--client-certificate", "--client-key", "--certificate-authority",
]);
const SAFE_ENV_KEYS = new Set([
  "CARGO_TERM_COLOR", "CARGO_TERM_PROGRESS_WHEN", "RUST_LOG", "RUST_LOG_STYLE", "RUST_BACKTRACE",
  "RUST_TEST_THREADS", "RUST_MIN_STACK", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "COLORTERM",
]);
const SIMPLE_SAFE = new Set([
  "ls", "cat", "pwd", "date", "whoami", "hostname", "uptime", "grep", "rg", "ps", "head", "tail",
  "wc", "sort", "uniq", "tr", "cut", "echo", "printf",
]);
const SETUP = new Set(["cd", "pushd", "popd", "export", "unset", "set", "sleep", "timeout"]);
const DANGEROUS = new Set(["rm", "chmod", "chown", "chgrp", "chattr", "pkill", "kill", "killall"]);

/**
 * Browser translation of native `evaluate_bash_segments` for word-only command
 * sequences. Anything the browser parser cannot prove equivalent fails closed
 * to one full-script prompt, matching native's `Unparseable` arm.
 */
export function analyzeGrokBuildBash(command: string): GrokBuildBashPermissionAnalysis {
  const parsed = parseWordOnlySequence(command);
  if (!parsed) return { segments: [command], needsPrompt: [command], dangerous: [], parseable: false };
  const segments: string[] = [];
  const needsPrompt: string[] = [];
  const dangerous: string[] = [];
  for (const entry of parsed) {
    const words = unwrapWrappers(entry.words);
    entry.unsafeEnvironment ||= wrapperHasUnsafeEnvironment(entry.words);
    if (!words.length || SETUP.has(words[0] ?? "")) continue;
    const segment = words.join(" ");
    segments.push(segment);
    if (isDangerous(words)) {
      dangerous.push(segment);
      needsPrompt.push(segment);
    } else if (entry.realFileRedirect || entry.unsafeEnvironment || wordsWriteRealFile(words) || !isSafeWords(words)) {
      needsPrompt.push(segment);
    }
  }
  return { segments, needsPrompt, dangerous, parseable: true };
}

/** Native protected-edit floor, projected onto browser-VFS absolute paths. */
export function protectedGrokBuildEdit(path: string): string | undefined {
  if (!path.startsWith("/")) return "sensitive";
  const components = normalizePath(path).toLowerCase().split("/").filter(Boolean);
  const file = components.at(-1) ?? "";
  const windows = (left: string, right: string): boolean => components.some((part, index) => part === left && components[index + 1] === right);
  if (windows(".grok", "hooks") || components.slice(-2).join("/") === ".grok/hooks-paths") return "hook_root";
  if (components.slice(-2).join("/") === ".claude/settings.json" || components.slice(-2).join("/") === ".claude/settings.local.json") return "claude_settings";
  if (components.slice(-2).join("/") === ".cursor/hooks.json") return "cursor_hooks";
  if (windows(".git", "hooks") || protectedSubmoduleHooks(components)) return "git_hooks";
  if (components.includes(".ssh")) return "ssh";
  if (new Set([".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".kshrc", ".cshrc", ".tcshrc", ".login", ".logout", ".inputrc", ".xprofile"]).has(file)) return "startup_file";
  if (components.at(-2) === ".grok" && ["config.toml", "managed_config.toml", "requirements.toml"].includes(file)) return "grok_config";
  if (components.at(-2) === ".grok" && file === "sandbox.toml") return "grok_sandbox";
  if (components[0] === "etc" || (components[0] === "private" && components[1] === "etc")) return "etc";
  return;
}

function protectedSubmoduleHooks(components: readonly string[]): boolean {
  for (let index = 0; index < components.length - 3; index += 1) {
    if (components[index] === ".git" && components[index + 1] === "modules" && components.slice(index + 3).includes("hooks")) return true;
  }
  return false;
}

interface ParsedSegment { words: string[]; realFileRedirect: boolean; unsafeEnvironment: boolean }

function parseWordOnlySequence(source: string): ParsedSegment[] | undefined {
  const result: ParsedSegment[] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let realFileRedirect = false;
  let unsafeEnvironment = false;
  let atWordStart = true;
  const pushWord = (): void => {
    if (!word.length) return;
    if (!words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      const key = word.slice(0, word.indexOf("="));
      unsafeEnvironment ||= !SAFE_ENV_KEYS.has(key);
    } else words.push(word);
    word = "";
    atWordStart = true;
  };
  const pushSegment = (): void => {
    pushWord();
    if (words.length) result.push({ words, realFileRedirect, unsafeEnvironment });
    words = [];
    realFileRedirect = false;
    unsafeEnvironment = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (escaped) { word += char; escaped = false; atWordStart = false; continue; }
    if (quote === "'") {
      if (char === "'") quote = undefined; else word += char;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = undefined; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "`" || (char === "$" && (next === "(" || next === "{"))) return;
      word += char;
      atWordStart = false;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; atWordStart = false; continue; }
    if (char === "\\") { escaped = true; atWordStart = false; continue; }
    if (char === "`" || (char === "$" && (next === "(" || next === "{")) || "(){}".includes(char)) return;
    if (char === "#" && atWordStart) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      pushWord();
      if (char === "\n") pushSegment();
      continue;
    }
    if (char === ";" || char === "|") {
      if (char === "|" && next === "|") index += 1;
      pushSegment();
      continue;
    }
    if (char === "&") {
      if (next !== "&") return;
      index += 1;
      pushSegment();
      continue;
    }
    if (char === ">" || char === "<") {
      if (/^\d+$/u.test(word)) word = ""; else pushWord();
      let end = index + 1;
      if (source[end] === char || source[end] === "&") end += 1;
      while (/\s/u.test(source[end] ?? "")) end += 1;
      const match = source.slice(end).match(/^([^\s;&|]+)/u);
      const target = match?.[1]?.replace(/^['"]|['"]$/gu, "");
      if (char === ">" && target && !["/dev/null", "/dev/stdout", "/dev/stderr"].includes(target) && !/^&?\d+$/u.test(target)) realFileRedirect = true;
      if (!target || target.includes("$") || target.includes("`")) realFileRedirect = true;
      if (match?.[0]) index = end + match[0].length - 1;
      continue;
    }
    word += char;
    atWordStart = false;
  }
  if (quote || escaped) return;
  pushSegment();
  return result.length ? result : undefined;
}

function unwrapWrappers(input: readonly string[]): string[] {
  let words = [...input];
  for (let depth = 0; depth < 8; depth += 1) {
    const head = basename(words[0] ?? "");
    let index = 0;
    if (head === "timeout") {
      index = 1;
      while (words[index]?.startsWith("-")) index += words[index] === "-k" || words[index] === "--kill-after" || words[index] === "-s" || words[index] === "--signal" ? 2 : 1;
      index += 1;
    } else if (head === "nice") {
      index = 1;
      if (words[index] === "-n" || words[index] === "--adjustment") index += 2;
      else if (/^-\d+$/u.test(words[index] ?? "")) index += 1;
    } else if (head === "ionice") {
      index = 1;
      while (words[index]?.startsWith("-")) index += ["-c", "--class", "-n", "--classdata", "-t", "--ignore"].includes(words[index] ?? "") ? 2 : 1;
    } else if (head === "chrt") {
      index = 1;
      while (words[index]?.startsWith("-")) index += ["-p", "--pid", "-m", "--max", "-a", "--all-tasks", "-r", "--rr", "-f", "--fifo", "-o", "--other", "-b", "--batch", "-d", "--deadline", "-i", "--idle"].includes(words[index] ?? "") ? 1 : 1;
      index += 1;
    } else if (head === "stdbuf") {
      index = 1;
      while (words[index]?.startsWith("-")) index += ["-i", "-o", "-e"].includes(words[index] ?? "") ? 2 : 1;
    } else if (head === "env") {
      index = 1;
      while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "") || words[index] === "-i" || words[index] === "--ignore-environment")) index += 1;
      if (words.slice(1, index).some((token) => token.startsWith("-S") || token.startsWith("--split-string"))) return [];
    } else break;
    if (index <= 0 || index >= words.length) break;
    words = words.slice(index);
  }
  return words;
}

function wrapperHasUnsafeEnvironment(words: readonly string[]): boolean {
  if (basename(words[0] ?? "") !== "env") return false;
  for (const token of words.slice(1)) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (match?.[1] && !SAFE_ENV_KEYS.has(match[1])) return true;
    if (!match && !token.startsWith("-")) break;
  }
  return false;
}

function wordsWriteRealFile(words: readonly string[]): boolean {
  const head = basename(words[0] ?? "").toLowerCase();
  if (["tee", "truncate", "set-content", "out-file", "add-content", "tee-object"].includes(head)) return true;
  if (head === "sort" && words.slice(1).some((word) => word === "-o" || word.startsWith("--output="))) return true;
  if (head === "sort" && words.slice(1).some((word) => word === "--compress-program" || word.startsWith("--compress-program=") || (word.length >= 4 && "--compress-program".startsWith(word)))) return true;
  if (head === "sed" && words.slice(1).some((word) => word === "-i" || word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place="))) return true;
  if (head === "dd" && words.slice(1).some((word) => word.startsWith("of="))) return true;
  if (head === "git" && words.slice(1).some((word) => word === "--output" || word.startsWith("--output="))) return true;
  return false;
}

function isSafeWords(words: readonly string[]): boolean {
  const head = words[0] ?? "";
  if (head === "git") return safeGit(words);
  if (head === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) return false;
  if (head === "ps" && psDumpsEnvironment(words)) return false;
  if (head === "kubectl") return ["get", "logs", "describe"].includes(words[1] ?? "")
    && !words.slice(1).some((word) => KUBECTL_UNSAFE_FLAGS.has(word.split("=")[0] ?? ""));
  if (head === "bin/explorer") return words[1] === "ls";
  return SIMPLE_SAFE.has(head) || head === "mkdir" || head === "touch";
}

function isDangerous(words: readonly string[]): boolean {
  const head = basename(words[0] ?? "").toLowerCase().replace(/\.exe$/u, "");
  return DANGEROUS.has(head) || (head === "git" && words[1] === "push");
}

function safeGit(words: readonly string[]): boolean {
  let index = 1;
  while (index < words.length && (words[index] ?? "").startsWith("-")) {
    if (words[index] === "-C") index += 2;
    else if ((words[index] ?? "").startsWith("-C") || words[index] === "--no-pager" || words[index] === "-P") index += 1;
    else return false;
  }
  const verb = words[index];
  if (!verb || !SAFE_GIT_SUBCOMMANDS.has(verb)) return false;
  return !words.slice(1).some((word) => {
    const flag = word.split("=")[0] ?? "";
    if (flag.length > 2 && GIT_QUERY_UNSAFE_OPTIONS.some((full) => full.startsWith(flag))) return true;
    return verb === "grep" && word.startsWith("-O");
  });
}

function psDumpsEnvironment(words: readonly string[]): boolean {
  let skipNext = false;
  for (const word of words.slice(1)) {
    if (skipNext) { skipNext = false; continue; }
    if (["-o", "-O", "--format", "--sort", "-p", "-q", "-t", "-u", "-U", "-g", "-G", "-C", "-s", "--pid", "--ppid", "--sid", "--tty", "--user", "--group", "--cols", "--columns", "--width", "o", "O"].includes(word)) { skipNext = true; continue; }
    if (word.startsWith("--format=") || word.startsWith("--sort=") || word.startsWith("-o") || word.startsWith("-O")) continue;
    if (word.includes("E") || (word.includes("e") && (!word.startsWith("-") || /[ax]/u.test(word)))) return true;
    if (/^-[^-].*[oO]$/u.test(word)) skipNext = true;
  }
  return false;
}

function basename(value: string): string { return value.split(/[\\/]/u).at(-1) ?? value; }

function normalizePath(value: string): string {
  const output: string[] = [];
  for (const part of value.replace(/\\/gu, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop(); else output.push(part);
  }
  return `/${output.join("/")}`;
}
