import { gzipSync } from "node:zlib";
import { readFileSync as readHostFileSync } from "node:fs";
import { VirtualFS } from "almostnode";
import { describe, expect, it, vi } from "vitest";
import {
  GROK_BUILD_BUNDLE_MANIFEST,
  extractGrokBuildBundleArchive,
  isGrokBuildBundleCacheFresh,
  readGrokBuildBundleManifest,
  sanitizeGrokBuildBundlePath,
  syncGrokBuildBundle,
  writeGrokBuildLegacyBundle,
} from "../experiments/browser-agent/src/grok-build-bundle.js";
import { discoverGrokBuildAgents } from "../experiments/browser-agent/src/grok-build-agents.js";
import { parseGrokBuildFrontmatterDocument } from "../experiments/browser-agent/src/grok-build-skills.js";

function tarOctal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarEntry(path: string, content: string | Uint8Array, type = "0"): Buffer {
  const body = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  tarOctal(0o644, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(body.byteLength, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let length = suffix.length + 1;
  while (`${length}`.length + suffix.length !== length) length = `${length}`.length + suffix.length;
  return `${length}${suffix}`;
}

function archive(entries: Array<[string, string, string?]>): Uint8Array {
  return gzipSync(Buffer.concat([
    ...entries.map(([path, content, type]) => tarEntry(path, content, type)),
    Buffer.alloc(1024),
  ]));
}

describe("Grok Build published bundle source port", () => {
  it("extracts the real archive recorded from native Grok Build", async () => {
    const lines = readHostFileSync("test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "utf8").split("\n");
    const exchange = lines.map((line) => line ? JSON.parse(line) as {
      kind?: string;
      key?: string;
      response?: { bodyBase64?: string };
    } : undefined).find((entry) => entry?.kind === "exchange" && entry.key === "GET /v1/bundle/archive");
    const encoded = exchange?.response?.bodyBase64;
    expect(encoded).toBeTruthy();

    const vfs = new VirtualFS();
    const manifest = await extractGrokBuildBundleArchive(vfs, Buffer.from(encoded!, "base64"));

    expect(manifest.version).toBe("public-2026-08-20-r2");
    expect(Object.keys(manifest.checksums)).toHaveLength(415);
    expect(Object.keys(manifest.checksums).filter((path) => path.startsWith("agents/"))).toHaveLength(3);
    expect(Object.keys(manifest.checksums).filter((path) => path.startsWith("skills/"))).toHaveLength(396);
    expect(Object.keys(manifest.checksums).filter((path) => path.startsWith("personas/"))).toHaveLength(7);
    expect(Object.keys(manifest.checksums).filter((path) => path.startsWith("roles/"))).toHaveLength(9);
    for (const name of ["general-purpose", "explore", "plan"]) {
      const published = parseGrokBuildFrontmatterDocument(vfs.readFileSync(`/.grok/bundled/agents/${name}.md`, "utf8"));
      const builtin = discoverGrokBuildAgents(vfs).find((definition) => definition.name === name)!;
      expect(builtin.promptBody).toBe(published.body.trim());
      expect(builtin.description).toBe(published.frontmatter?.description);
    }
  }, 20_000);

  it("extracts PAX paths, maps native roots, and ignores unknown top-level files", async () => {
    const vfs = new VirtualFS();
    const bytes = archive([
      ["bundle.json", JSON.stringify({ version: "2026.08.27" })],
      ["PaxHeaders.0/skill", paxRecord("path", "skills/game-dev/SKILL.md"), "x"],
      ["placeholder", "---\nname: game-dev\ndescription: Build games\n---\n"],
      ["subagents/agents/reviewer.md", "Review carefully"],
      ["workflows/research.rhai", "let x = 1;"],
      ["unrelated/file.txt", "ignored"],
    ]);

    const manifest = await extractGrokBuildBundleArchive(vfs, bytes);

    expect(manifest.version).toBe("2026.08.27");
    expect(vfs.readFileSync("/.grok/bundled/skills/game-dev/SKILL.md", "utf8")).toContain("Build games");
    expect(vfs.readFileSync("/.grok/bundled/agents/reviewer.md", "utf8")).toBe("Review carefully");
    expect(vfs.readFileSync("/.grok/bundled/workflows/research.rhai", "utf8")).toBe("let x = 1;");
    expect(vfs.existsSync("/.grok/bundled/unrelated/file.txt")).toBe(false);
    expect(readGrokBuildBundleManifest(vfs)).toEqual(manifest);
    expect(isGrokBuildBundleCacheFresh(vfs)).toBe(true);
  });

  it("never overwrites or prunes user-modified managed files", async () => {
    const vfs = new VirtualFS();
    await extractGrokBuildBundleArchive(vfs, archive([
      ["bundle.json", JSON.stringify({ version: "v1" })],
      ["subagents/agents/keep.md", "managed-v1"],
      ["subagents/agents/remove.md", "managed-remove"],
    ]));
    const old = readGrokBuildBundleManifest(vfs)!;
    vfs.writeFileSync("/.grok/bundled/agents/keep.md", "user edit");
    vfs.writeFileSync("/.grok/bundled/agents/remove.md", "user edit too");

    const next = await extractGrokBuildBundleArchive(vfs, archive([
      ["bundle.json", JSON.stringify({ version: "v2" })],
      ["subagents/agents/keep.md", "managed-v2"],
    ]));

    expect(vfs.readFileSync("/.grok/bundled/agents/keep.md", "utf8")).toBe("user edit");
    expect(vfs.readFileSync("/.grok/bundled/agents/remove.md", "utf8")).toBe("user edit too");
    expect(next.checksums["agents/keep.md"]).toBe(old.checksums["agents/keep.md"]);
    expect(next.checksums["agents/remove.md"]).toBe(old.checksums["agents/remove.md"]);
  });

  it("prunes unchanged managed files and preserves archive workflows across JSON fallback", async () => {
    const vfs = new VirtualFS();
    await extractGrokBuildBundleArchive(vfs, archive([
      ["bundle.json", JSON.stringify({ version: "v1" })],
      ["subagents/roles/old.toml", "role = 'old'"],
      ["workflows/research.rhai", "let x = 1;"],
    ]));

    const manifest = await writeGrokBuildLegacyBundle(vfs, {
      version: "v2",
      personas: {},
      roles: {},
      agents: {},
      skills: { commit: "# Commit\n\nCreate a commit." },
    });

    expect(vfs.existsSync("/.grok/bundled/roles/old.toml")).toBe(false);
    expect(vfs.existsSync("/.grok/bundled/workflows/research.rhai")).toBe(true);
    expect(manifest.checksums).toHaveProperty("workflows/research.rhai");
    expect(vfs.readFileSync("/.grok/bundled/skills/commit/SKILL.md", "utf8")).toContain("Create a commit");
  });

  it("uses archive-first fallback semantics and never falls back after a 401", async () => {
    const vfs = new VirtualFS();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: "legacy-v1", personas: {}, roles: {}, agents: {}, skills: {},
      }), { headers: { "Content-Type": "application/json" } }));

    await expect(syncGrokBuildBundle(vfs, { fetch: fetchMock, force: true })).resolves.toMatchObject({ source: "legacy", updated: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/grok/bundle/archive", "/api/grok/subagents/bundle"]);

    const unauthorized = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(syncGrokBuildBundle(new VirtualFS(), { fetch: unauthorized, force: true })).rejects.toThrow("unauthorized");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("falls back on any non-success archive status but not on transport or successful-decode failure", async () => {
    const legacyPayload = JSON.stringify({ version: "legacy", personas: {}, roles: {}, agents: {} });
    const unavailable = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(legacyPayload));
    await expect(syncGrokBuildBundle(new VirtualFS(), { fetch: unavailable, force: true }))
      .resolves.toMatchObject({ source: "legacy", manifest: { version: "legacy" } });

    const malformedArchive = vi.fn().mockResolvedValue(new Response("not a gzip archive", { status: 200 }));
    await expect(syncGrokBuildBundle(new VirtualFS(), { fetch: malformedArchive, force: true })).rejects.toThrow();
    expect(malformedArchive).toHaveBeenCalledTimes(1);

    const transportFailure = vi.fn().mockRejectedValue(new TypeError("network down"));
    await expect(syncGrokBuildBundle(new VirtualFS(), { fetch: transportFailure, force: true })).rejects.toThrow("network down");
    expect(transportFailure).toHaveBeenCalledTimes(1);
  });

  it("uses native manifest parse/freshness semantics and sanitizes only before cache mutation", async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok/bundled", { recursive: true });
    vfs.writeFileSync(GROK_BUILD_BUNDLE_MANIFEST, JSON.stringify({
      version: "v1",
      checksums: { "agents/good.md": "abc", "../outside": "unsafe-but-parseable" },
    }));
    expect(readGrokBuildBundleManifest(vfs)?.checksums).toHaveProperty("../outside");
    expect(isGrokBuildBundleCacheFresh(vfs)).toBe(true);

    vfs.writeFileSync(GROK_BUILD_BUNDLE_MANIFEST, JSON.stringify({ version: "v1", checksums: { "agents/good.md": 1 } }));
    expect(readGrokBuildBundleManifest(vfs)).toBeUndefined();
    expect(isGrokBuildBundleCacheFresh(vfs)).toBe(false);

    vfs.writeFileSync(GROK_BUILD_BUNDLE_MANIFEST, "{broken");
    expect(isGrokBuildBundleCacheFresh(vfs)).toBe(false);
    await expect(extractGrokBuildBundleArchive(vfs, archive([
      ["bundle.json", JSON.stringify({ version: "v2" })],
      ["subagents/agents/new.md", "new"],
    ]))).rejects.toThrow(`failed to parse ${GROK_BUILD_BUNDLE_MANIFEST}`);
    expect(vfs.existsSync("/.grok/bundled/agents/new.md")).toBe(false);
  });

  it("validates every legacy bundle name before writing any entry", async () => {
    const vfs = new VirtualFS();
    await expect(writeGrokBuildLegacyBundle(vfs, {
      version: "v1",
      personas: { valid: "valid", "../invalid": "invalid" },
      roles: {},
      agents: {},
      skills: {},
    })).rejects.toThrow("invalid bundled personas name");
    expect(vfs.existsSync("/.grok/bundled/personas/valid.toml")).toBe(false);
  });

  it("streams archive entries so a later tar failure preserves native partial-write ordering", async () => {
    const vfs = new VirtualFS();
    const corrupt = tarEntry("subagents/agents/bad.md", "bad");
    corrupt[0] = corrupt[0]! ^ 1; // invalidate the already-computed header checksum
    const bytes = gzipSync(Buffer.concat([
      tarEntry("bundle.json", JSON.stringify({ version: "v1" })),
      tarEntry("subagents/agents/first.md", "first"),
      corrupt,
      Buffer.alloc(1024),
    ]));

    await expect(extractGrokBuildBundleArchive(vfs, bytes)).rejects.toThrow("invalid tar checksum");
    expect(vfs.readFileSync("/.grok/bundled/agents/first.md", "utf8")).toBe("first");
    expect(vfs.existsSync(GROK_BUILD_BUNDLE_MANIFEST)).toBe(false);
  });

  it("accepts only the native cache path shapes", () => {
    expect(sanitizeGrokBuildBundlePath("agents/reviewer.md")).toBe("agents/reviewer.md");
    expect(sanitizeGrokBuildBundlePath("skills/game-dev/references/guide.md")).toBe("skills/game-dev/references/guide.md");
    expect(sanitizeGrokBuildBundlePath("skills/game-dev/../secret")).toBeUndefined();
    expect(sanitizeGrokBuildBundlePath("/agents/reviewer.md")).toBeUndefined();
    expect(sanitizeGrokBuildBundlePath("roles/nested/reviewer.toml")).toBeUndefined();
    expect(sanitizeGrokBuildBundlePath("skills/game-dev")).toBeUndefined();
    expect(GROK_BUILD_BUNDLE_MANIFEST).toBe("/.grok/bundled/manifest.json");
  });
});
