// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.
//
// Source port of xai-grok-bundle and xai-grok-shell's published-bundle sync.

export const GROK_BUILD_BUNDLED_ROOT = "/.grok/bundled";
export const GROK_BUILD_BUNDLE_MANIFEST = `${GROK_BUILD_BUNDLED_ROOT}/manifest.json`;
export const GROK_BUILD_BUNDLE_TTL_MS = 60 * 60 * 1_000;
export const GROK_BUILD_BUNDLE_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const GROK_BUILD_BUNDLE_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
export const GROK_BUILD_BUNDLE_MAX_ENTRY_BYTES = 1024 * 1024;
export const GROK_BUILD_BUNDLE_MAX_ENTRIES = 1_000;

const TAR_BLOCK_BYTES = 512;
// The native cap applies to regular-file payloads. This additional browser-only
// ceiling prevents gzip metadata/padding from becoming an allocation bomb.
const TAR_STREAM_MAX_BYTES = GROK_BUILD_BUNDLE_MAX_DECOMPRESSED_BYTES + 8 * 1024 * 1024;
const BUNDLE_DIRECTORIES = ["personas", "roles", "agents", "skills", "workflows"] as const;

export interface GrokBuildBundleFileSystem {
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; mtimeMs: number };
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  writeFileSync(path: string, data: string | Uint8Array): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
}

export interface GrokBuildBundleManifest {
  version: string;
  checksums: Record<string, string>;
}

export interface GrokBuildLegacyBundle {
  version: string;
  personas: Record<string, string>;
  roles: Record<string, string>;
  agents: Record<string, string>;
  skills: Record<string, string>;
}

export interface GrokBuildBundleSyncResult {
  source: "archive" | "legacy" | "fresh-cache";
  updated: boolean;
  manifest?: GrokBuildBundleManifest;
}

export interface GrokBuildBundleSyncOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  force?: boolean;
  now?: number;
  archiveEndpoint?: string;
  legacyEndpoint?: string;
}

interface TarEntry {
  path: string;
  type: number;
  content: Uint8Array;
}

function joinRoot(relativePath: string): string {
  return `${GROK_BUILD_BUNDLED_ROOT}/${relativePath}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function ensureBundleDirectories(vfs: GrokBuildBundleFileSystem): void {
  vfs.mkdirSync(GROK_BUILD_BUNDLED_ROOT, { recursive: true });
  for (const directory of BUNDLE_DIRECTORIES) {
    vfs.mkdirSync(joinRoot(directory), { recursive: true });
  }
}

function validateBundleName(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && ![...name].some((character) => /\p{Cc}/u.test(character));
}

export function sanitizeGrokBuildBundlePath(relativePath: string): string | undefined {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) return;
  const parts = relativePath.split("/");
  if (parts.length === 2) {
    const [directory, filename] = parts;
    const extension = directory === "personas" || directory === "roles" ? ".toml"
      : directory === "agents" ? ".md"
      : directory === "workflows" ? ".rhai"
      : undefined;
    if (!extension || !filename?.endsWith(extension)) return;
    const stem = filename.slice(0, -extension.length);
    return validateBundleName(stem) ? `${directory}/${stem}${extension}` : undefined;
  }
  if (parts.length >= 3 && parts[0] === "skills" && validateBundleName(parts[1] ?? "")) {
    if (parts.slice(2).some((part) => !part || part === "." || part === ".." || [...part].some((character) => /\p{Cc}/u.test(character)))) return;
    return relativePath;
  }
  return;
}

function mapArchivePath(path: string): string | undefined {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  if (normalized.startsWith("subagents/")) return sanitizeGrokBuildBundlePath(normalized.slice("subagents/".length));
  if (normalized.startsWith("skills/") || normalized.startsWith("workflows/")) {
    return sanitizeGrokBuildBundlePath(normalized);
  }
  return;
}

function parseManifest(value: unknown): GrokBuildBundleManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as { version?: unknown; checksums?: unknown };
  if (typeof raw.version !== "string" || !raw.checksums || typeof raw.checksums !== "object" || Array.isArray(raw.checksums)) return;
  if (Object.values(raw.checksums as Record<string, unknown>).some((checksum) => typeof checksum !== "string")) return;
  const checksums = raw.checksums as Record<string, string>;
  return { version: raw.version, checksums };
}

function sanitizeManifest(manifest: GrokBuildBundleManifest | undefined): GrokBuildBundleManifest | undefined {
  if (!manifest) return;
  const checksums: Record<string, string> = {};
  for (const [path, checksum] of Object.entries(manifest.checksums)) {
    const safe = sanitizeGrokBuildBundlePath(path);
    if (safe) checksums[safe] = checksum;
  }
  return { version: manifest.version, checksums };
}

export function readGrokBuildBundleManifest(vfs: GrokBuildBundleFileSystem): GrokBuildBundleManifest | undefined {
  if (!vfs.existsSync(GROK_BUILD_BUNDLE_MANIFEST)) return;
  try {
    return parseManifest(JSON.parse(vfs.readFileSync(GROK_BUILD_BUNDLE_MANIFEST, "utf8")) as unknown);
  } catch {
    return;
  }
}

function readManifestForMutation(vfs: GrokBuildBundleFileSystem): GrokBuildBundleManifest | undefined {
  if (!vfs.existsSync(GROK_BUILD_BUNDLE_MANIFEST)) return;
  let value: unknown;
  try {
    value = JSON.parse(vfs.readFileSync(GROK_BUILD_BUNDLE_MANIFEST, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`failed to parse ${GROK_BUILD_BUNDLE_MANIFEST}`, { cause: error });
  }
  const manifest = parseManifest(value);
  if (!manifest) throw new Error(`failed to parse ${GROK_BUILD_BUNDLE_MANIFEST}`);
  return manifest;
}

export function isGrokBuildBundleCacheFresh(
  vfs: GrokBuildBundleFileSystem,
  now = Date.now(),
  ttlMs = GROK_BUILD_BUNDLE_TTL_MS,
): boolean {
  if (!readGrokBuildBundleManifest(vfs)) return false;
  try {
    const age = now - vfs.statSync(GROK_BUILD_BUNDLE_MANIFEST).mtimeMs;
    return age >= 0 && age < ttlMs;
  } catch {
    return false;
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentChecksum(vfs: GrokBuildBundleFileSystem, path: string): Promise<string | undefined> {
  if (!vfs.existsSync(path)) return;
  return sha256Bytes(vfs.readFileSync(path));
}

async function writeManagedFile(
  vfs: GrokBuildBundleFileSystem,
  relativePath: string,
  content: Uint8Array,
  oldManifest: GrokBuildBundleManifest | undefined,
  nextChecksums: Record<string, string>,
): Promise<void> {
  const absolutePath = joinRoot(relativePath);
  const previousChecksum = oldManifest?.checksums[relativePath];
  const checksum = await currentChecksum(vfs, absolutePath);
  if (checksum === undefined || (previousChecksum !== undefined && checksum === previousChecksum)) {
    vfs.mkdirSync(parentPath(absolutePath), { recursive: true });
    vfs.writeFileSync(absolutePath, content);
    nextChecksums[relativePath] = await sha256Bytes(content);
  } else if (previousChecksum !== undefined) {
    nextChecksums[relativePath] = previousChecksum;
  }
}

async function pruneRemovedFiles(
  vfs: GrokBuildBundleFileSystem,
  oldManifest: GrokBuildBundleManifest | undefined,
  nextChecksums: Record<string, string>,
): Promise<void> {
  if (!oldManifest) return;
  for (const [relativePath, previousChecksum] of Object.entries(oldManifest.checksums)) {
    if (relativePath in nextChecksums) continue;
    const absolutePath = joinRoot(relativePath);
    const checksum = await currentChecksum(vfs, absolutePath);
    if (checksum === undefined) continue;
    if (checksum === previousChecksum) vfs.unlinkSync(absolutePath);
    else nextChecksums[relativePath] = previousChecksum;
  }
}

function writeManifest(vfs: GrokBuildBundleFileSystem, manifest: GrokBuildBundleManifest): void {
  vfs.writeFileSync(GROK_BUILD_BUNDLE_MANIFEST, JSON.stringify(manifest, null, 2));
}

function parseTarString(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero >= 0 ? bytes.subarray(0, zero) : bytes).trimEnd();
}

function parseTarNumber(bytes: Uint8Array): number {
  if ((bytes[0] ?? 0) & 0x80) {
    let value = BigInt((bytes[0] ?? 0) & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("archive entry size exceeds the safe integer range");
    return Number(value);
  }
  const text = parseTarString(bytes).trim().replace(/^0+/u, "") || "0";
  if (!/^[0-7]+$/u.test(text)) throw new Error("failed to read archive entry size");
  return Number.parseInt(text, 8);
}

function validateTarChecksum(header: Uint8Array): void {
  const expected = parseTarNumber(header.subarray(148, 156));
  let unsigned = 0;
  for (let index = 0; index < header.length; index += 1) {
    unsigned += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
  }
  if (expected !== unsigned) throw new Error("archive entry has an invalid tar checksum");
}

function parsePax(payload: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(payload);
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) throw new Error("archive contains a malformed PAX record");
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.length) throw new Error("archive contains a malformed PAX record");
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

async function* streamTarEntries(compressed: Uint8Array): AsyncGenerator<TarEntry> {
  const compressedBuffer = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
  const reader = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let buffered = new Uint8Array();
  let streamBytes = 0;
  let streamDone = false;
  let localPax: Record<string, string> | undefined;
  let globalPax: Record<string, string> = {};
  let longPath: string | undefined;
  let regularEntries = 0;
  let regularBytes = 0;

  const fill = async (minimum: number): Promise<boolean> => {
    while (buffered.byteLength < minimum && !streamDone) {
      const { done, value } = await reader.read();
      if (done) { streamDone = true; break; }
      streamBytes += value.byteLength;
      if (streamBytes > TAR_STREAM_MAX_BYTES) throw new Error(`archive exceeds browser extraction ceiling (${TAR_STREAM_MAX_BYTES} bytes)`);
      const joined = new Uint8Array(buffered.byteLength + value.byteLength);
      joined.set(buffered);
      joined.set(value, buffered.byteLength);
      buffered = joined;
    }
    return buffered.byteLength >= minimum;
  };
  const take = (length: number): Uint8Array => {
    const value = buffered.slice(0, length);
    buffered = buffered.slice(length);
    return value;
  };

  try {
    while (await fill(TAR_BLOCK_BYTES)) {
      const header = take(TAR_BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) break;
      validateTarChecksum(header);
      const size = parseTarNumber(header.subarray(124, 136));
      const type = header[156] ?? 0;
      if (type === 0 || type === 48) {
        regularEntries += 1;
        if (regularEntries > GROK_BUILD_BUNDLE_MAX_ENTRIES) throw new Error(`archive exceeds maximum entry count (${GROK_BUILD_BUNDLE_MAX_ENTRIES})`);
        if (size > GROK_BUILD_BUNDLE_MAX_ENTRY_BYTES) throw new Error(`archive entry exceeds maximum size (${GROK_BUILD_BUNDLE_MAX_ENTRY_BYTES} bytes)`);
        regularBytes += size;
        if (!Number.isSafeInteger(regularBytes)) throw new Error("decompressed size overflow");
        if (regularBytes > GROK_BUILD_BUNDLE_MAX_DECOMPRESSED_BYTES) throw new Error(`archive exceeds maximum decompressed size (${GROK_BUILD_BUNDLE_MAX_DECOMPRESSED_BYTES} bytes)`);
      }
      const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      if (!Number.isSafeInteger(paddedSize) || !(await fill(paddedSize))) throw new Error("archive entry is truncated");
      const content = take(size);
      take(paddedSize - size);
      const name = parseTarString(header.subarray(0, 100));
      const prefix = parseTarString(header.subarray(345, 500));
      const headerPath = prefix ? `${prefix}/${name}` : name;
      if (type === 120) localPax = parsePax(content);
      else if (type === 103) globalPax = { ...globalPax, ...parsePax(content) };
      else if (type === 76) longPath = parseTarString(content);
      else {
        const path = localPax?.path ?? globalPax.path ?? longPath ?? headerPath;
        yield { path, type, content };
        localPax = undefined;
        longPath = undefined;
      }
    }
    if (!streamDone && buffered.byteLength > 0 && buffered.byteLength < TAR_BLOCK_BYTES) {
      throw new Error("archive entry is truncated");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function extractGrokBuildBundleArchive(
  vfs: GrokBuildBundleFileSystem,
  archiveBytes: Uint8Array,
): Promise<GrokBuildBundleManifest> {
  if (archiveBytes.byteLength > GROK_BUILD_BUNDLE_MAX_COMPRESSED_BYTES) throw new Error("Grok bundle archive is too large.");
  const oldManifest = sanitizeManifest(readManifestForMutation(vfs));
  ensureBundleDirectories(vfs);
  const nextChecksums: Record<string, string> = {};
  let version = "";
  for await (const entry of streamTarEntries(archiveBytes)) {
    if (entry.type !== 0 && entry.type !== 48) continue;
    const normalized = entry.path.startsWith("./") ? entry.path.slice(2) : entry.path;
    if (normalized === "bundle.json") {
      const metadata = JSON.parse(new TextDecoder().decode(entry.content)) as { version?: unknown };
      if (typeof metadata.version !== "string") throw new Error("failed to parse bundle.json");
      version = metadata.version;
      continue;
    }
    const relativePath = mapArchivePath(entry.path);
    if (relativePath) await writeManagedFile(vfs, relativePath, entry.content, oldManifest, nextChecksums);
  }
  if (!version) throw new Error("archive missing bundle.json with version field");
  await pruneRemovedFiles(vfs, oldManifest, nextChecksums);
  const manifest = { version, checksums: nextChecksums };
  writeManifest(vfs, manifest);
  return manifest;
}

function parseLegacyBundle(value: unknown): GrokBuildLegacyBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid legacy Grok bundle");
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== "string") throw new Error("legacy Grok bundle is missing its version");
  const maps = ["personas", "roles", "agents"] as const;
  const result = { version: raw.version } as GrokBuildLegacyBundle;
  for (const key of maps) {
    const map = raw[key];
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map as Record<string, unknown>).some((item) => typeof item !== "string")) {
      throw new Error(`legacy Grok bundle has an invalid ${key} map`);
    }
    result[key] = map as Record<string, string>;
  }
  const skills = raw.skills ?? {};
  if (!skills || typeof skills !== "object" || Array.isArray(skills) || Object.values(skills as Record<string, unknown>).some((item) => typeof item !== "string")) {
    throw new Error("legacy Grok bundle has an invalid skills map");
  }
  result.skills = skills as Record<string, string>;
  return result;
}

export async function writeGrokBuildLegacyBundle(
  vfs: GrokBuildBundleFileSystem,
  value: unknown,
): Promise<GrokBuildBundleManifest> {
  const bundle = parseLegacyBundle(value);
  const oldManifest = sanitizeManifest(readManifestForMutation(vfs));
  const kinds = [
    ["personas", ".toml", bundle.personas],
    ["roles", ".toml", bundle.roles],
    ["agents", ".md", bundle.agents],
    ["skills", "", bundle.skills],
  ] as const;
  // Native `bundle_files` validates the entire JSON payload before creating
  // directories or writing the first file.
  const files: Array<{ relativePath: string; content: string }> = [];
  for (const [directory, extension, entries] of kinds) {
    for (const [name, content] of Object.entries(entries)) {
      if (!validateBundleName(name)) throw new Error(`invalid bundled ${directory} name: ${JSON.stringify(name)}`);
      const relativePath = directory === "skills" ? `skills/${name}/SKILL.md` : `${directory}/${name}${extension}`;
      files.push({ relativePath, content });
    }
  }
  ensureBundleDirectories(vfs);
  const nextChecksums: Record<string, string> = {};
  for (const file of files) {
    await writeManagedFile(vfs, file.relativePath, new TextEncoder().encode(file.content), oldManifest, nextChecksums);
  }
  if (oldManifest) {
    for (const [path, checksum] of Object.entries(oldManifest.checksums)) {
      if (path.startsWith("workflows/") && !(path in nextChecksums)) nextChecksums[path] = checksum;
    }
  }
  await pruneRemovedFiles(vfs, oldManifest, nextChecksums);
  const manifest = { version: bundle.version, checksums: nextChecksums };
  writeManifest(vfs, manifest);
  return manifest;
}

async function readBoundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Grok bundle response is too large.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Grok bundle response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function syncGrokBuildBundle(
  vfs: GrokBuildBundleFileSystem,
  options: GrokBuildBundleSyncOptions = {},
): Promise<GrokBuildBundleSyncResult> {
  if (!options.force && isGrokBuildBundleCacheFresh(vfs, options.now)) {
    const manifest = readGrokBuildBundleManifest(vfs);
    return { source: "fresh-cache", updated: false, ...(manifest ? { manifest } : {}) };
  }
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const archive = await fetchImpl(options.archiveEndpoint ?? "/api/grok/bundle/archive", {
    credentials: "include",
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (archive.ok) {
    const manifest = await extractGrokBuildBundleArchive(vfs, await readBoundedResponse(archive, GROK_BUILD_BUNDLE_MAX_COMPRESSED_BYTES));
    return { source: "archive", updated: true, manifest };
  }
  if (archive.status === 401) throw new Error((await archive.text().catch(() => "")) || "Grok bundle request returned HTTP 401.");
  await archive.body?.cancel().catch(() => undefined);
  const legacy = await fetchImpl(options.legacyEndpoint ?? "/api/grok/subagents/bundle", {
    credentials: "include",
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await readBoundedResponse(legacy, GROK_BUILD_BUNDLE_MAX_COMPRESSED_BYTES);
  if (!legacy.ok) throw new Error(new TextDecoder().decode(body) || `Grok legacy bundle request returned HTTP ${legacy.status}.`);
  const manifest = await writeGrokBuildLegacyBundle(vfs, JSON.parse(new TextDecoder().decode(body)) as unknown);
  return { source: "legacy", updated: true, manifest };
}
