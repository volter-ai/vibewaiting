import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";
import { parseGrokPdfPages } from "../experiments/browser-agent/src/grok-build-filesystem.js";

const signal = new AbortController().signal;

describe("Grok Build rich browser file reads", () => {
  it("accepts native lenient signed offsets and extracts inline data-URI attachments", async () => {
    const vfs = new VirtualFS();
    const payload = "A".repeat(1_024);
    vfs.writeFileSync("/notes.txt", `first\nsecond\nimage data:image/png;charset=utf-8;BASE64,${payload} tail\nlast\n`);
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({
      callId: "inline-image",
      name: "read_file",
      arguments: JSON.stringify({ target_file: "/notes.txt", offset: "-3", limit: 1 }),
    }, signal);
    expect(result.output).toBe("3→image [image content will be provided separately] tail");
    expect(result.images).toEqual([`data:image/png;base64,${payload}`]);
  });

  it("keeps small and word-internal data URIs but strips PDF attachments", async () => {
    const vfs = new VirtualFS();
    const pdfPayload = "A".repeat(2_000);
    vfs.writeFileSync("/uris.txt", `metadata:image/png;base64,${"A".repeat(2_000)}\ndata:image/gif;base64,${"A".repeat(100)}\ndata:application/pdf;base64,${pdfPayload}`);
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({ callId: "uris", name: "read_file", arguments: '{"target_file":"/uris.txt"}' }, signal);
    expect(result.output).toContain("1→metadata:image/png;base64,");
    expect(result.output).toContain("data:image/gif;base64,");
    expect(result.output).toContain("[PDF attachment removed — 1 KB]");
    expect(result.images).toBeUndefined();
  });

  it("matches native PDF page-range parsing edge cases", () => {
    expect(parseGrokPdfPages("1,3,7-9", 10)).toEqual([0, 2, 6, 7, 8]);
    expect(parseGrokPdfPages("5,3,1,3,5", 10)).toEqual([0, 2, 4]);
    expect(parseGrokPdfPages("1-100", 5)).toEqual([0, 1, 2, 3, 4]);
    expect(() => parseGrokPdfPages("1-2-3", 10)).toThrow("invalid page number: '2-3'");
    expect(() => parseGrokPdfPages("1-21", 30)).toThrow("requested 21 pages, maximum is 20 per call");
    expect(() => parseGrokPdfPages("", 10)).toThrow("no pages specified");
    expect(() => parseGrokPdfPages(",,,", 10)).toThrow("no pages specified");
    expect(() => parseGrokPdfPages("1", 0)).toThrow("page 1 out of range (document has 0 pages)");
  });

  it("attaches native-shaped image function output instead of treating bytes as text", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/frame.png", Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAvSURBVFiF7c4xAQAwDIAwNv+eWxl9ggHypqbD/uUcAAAAAAAAAAAAAAAAAACgagEw4wI+0ujnJgAAAABJRU5ErkJggg==", "base64")));
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    await expect(runtime.execute({ callId: "image", name: "read_file", arguments: '{"target_file":"/frame.png"}' }, signal)).resolves.toMatchObject({
      output: "Read image file: /frame.png",
      images: [expect.stringMatching(/^data:image\/png;base64,/u)],
    });
  });

  it("does not pass a CRC-corrupt small PNG through the endpoint-native fast path", async () => {
    const valid = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAvSURBVFiF7c4xAQAwDIAwNv+eWxl9ggHypqbD/uUcAAAAAAAAAAAAAAAAAACgagEw4wI+0ujnJgAAAABJRU5ErkJggg==", "base64"));
    const corrupt = valid.slice();
    corrupt[80] = (corrupt[80] ?? 0) ^ 0x01;
    const vfs = new VirtualFS();
    vfs.writeFileSync("/corrupt.png", corrupt);
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({ callId: "bad-image", name: "read_file", arguments: '{"target_file":"/corrupt.png"}' }, signal);
    expect(result.output).toContain("Could not embed image in conversation:");
    expect(result.images).toBeUndefined();
  });

  it("uses magic bytes rather than an image extension to select multimodal reads", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/pretend.png", "plain text");
    vfs.writeFileSync("/vector.svg", "<svg><text>Hello</text></svg>");
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    await expect(runtime.execute({ callId: "pretend", name: "read_file", arguments: '{"target_file":"/pretend.png"}' }, signal))
      .resolves.toEqual({ output: "Cannot read binary file: /pretend.png" });
    await expect(runtime.execute({ callId: "svg", name: "read_file", arguments: '{"target_file":"/vector.svg"}' }, signal))
      .resolves.toEqual({ output: "1→<svg><text>Hello</text></svg>" });
  });

  it("extracts ordered PPTX slide and notes text entirely in the browser", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/deck.pptx", storedZip({
      "ppt/slides/slide10.xml": '<p:sld xmlns:a="a"><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
      "ppt/slides/slide2.xml": '<p:sld xmlns:a="a"><a:p><a:r><a:t>Two &amp; </a:t></a:r><a:r><a:t>more</a:t></a:r></a:p><a:p><a:r><a:t/></a:r>stray<a:r><a:t>Kept</a:t></a:r></a:p></p:sld>',
      "ppt/notesSlides/notesSlide2.xml": '<p:notes xmlns:a="a"><a:p><a:r><a:t>Remember this</a:t></a:r></a:p></p:notes>',
    }));
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({ callId: "pptx", name: "read_file", arguments: '{"target_file":"/deck.pptx"}' }, signal);
    expect(result.output).toBe("1→--- Slide 2 ---\n2→Two & more\n3→Kept\n4→\n5→Speaker Notes:\n6→Remember this\n7→\n8→--- Slide 10 ---\n9→Ten");
  });

  it("extracts PDF text with native all-line anchors", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/doc.pdf", makePdf("Hello PDF"));
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({ callId: "pdf", name: "read_file", arguments: '{"target_file":"/doc.pdf","format":"text"}' }, signal);
    expect(result.output).toContain("1→--- Page 1 ---\n2→Hello PDF");
  });
});

describe("Grok Build browser background task control", () => {
  it("uses UUIDv7 IDs, preserves full logs, and renders native truncation cards", async () => {
    const vfs = new VirtualFS();
    const full = "x".repeat(45_000);
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: full, stderr: "", exitCode: 0 }; } });
    const started = await runtime.execute({ callId: "start", name: "run_terminal_command", arguments: '{"command":"generate","background":true}' }, signal);
    const id = /task ID: ([0-9a-f-]+)/u.exec(started.output)?.[1];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const polled = await runtime.execute({ callId: "poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal);
    expect(polled.output).toContain(`=== Task ${id} ===\nCommand: generate\nStatus: completed`);
    expect(polled.output).toContain(`[Output truncated - 45000 bytes total. Use read_file on /tmp/${id}.log for full content]`);
    expect(polled.output).toContain("[truncated - use read_file on output_file for full content]");
    expect(vfs.readFileSync(`/tmp/${id}.log`, "utf8")).toBe(full);
  });

  it("deduplicates multi-task polls, includes missing rows, and reports kill outcomes", async () => {
    vi.useFakeTimers();
    try {
      const vfs = new VirtualFS();
      const runtime = new GrokBuildBrowserRuntime({
        vfs,
        async run(_command, options) {
          return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: 130 }), { once: true }));
        },
      });
      const started = await runtime.execute({ callId: "start", name: "run_terminal_command", arguments: '{"command":"watch","background":true}' }, signal);
      const id = /task ID: ([0-9a-f-]+)/u.exec(started.output)?.[1] ?? "";
      const multi = await runtime.execute({ callId: "multi", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id, id, "missing"] }) }, signal);
      expect(multi.output.match(new RegExp(`--- Task ${id}`, "gu"))).toHaveLength(1);
      expect(multi.output).toContain("--- Task missing [not_found] ---");
      expect(multi.output).toContain("0/2 tasks completed (poll)");
      await expect(runtime.execute({ callId: "kill", name: "kill_command_or_subagent", arguments: JSON.stringify({ task_id: id }) }, signal))
        .resolves.toEqual({ output: "killed: Task was terminated successfully" });
      await expect(runtime.execute({ callId: "kill-again", name: "kill_command_or_subagent", arguments: JSON.stringify({ task_id: id }) }, signal))
        .resolves.toEqual({ output: "already_exited: Task had already completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes streamed output while running and preserves native empty-output wording", async () => {
    const vfs = new VirtualFS();
    let release: ((result: { stdout: string; stderr: string; exitCode: number }) => void) | undefined;
    const runtime = new GrokBuildBrowserRuntime({
      vfs,
      async run(_command, options) {
        options?.onStdout?.("partial output");
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const started = await runtime.execute({ callId: "live-start", name: "run_terminal_command", arguments: '{"command":"stream","background":true}' }, signal);
    const id = /task ID: ([0-9a-f-]+)/u.exec(started.output)?.[1] ?? "";
    const live = await runtime.execute({ callId: "live-poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal);
    expect(live.output).toContain("partial output\n\nUse timeout_ms to wait for completion.");
    release?.({ stdout: "", stderr: "", exitCode: 0 });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const emptyRuntime = new GrokBuildBrowserRuntime({ vfs: new VirtualFS(), async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });
    const emptyStarted = await emptyRuntime.execute({ callId: "empty-start", name: "run_terminal_command", arguments: '{"command":"true","background":true}' }, signal);
    const emptyId = /task ID: ([0-9a-f-]+)/u.exec(emptyStarted.output)?.[1] ?? "";
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const empty = await emptyRuntime.execute({ callId: "empty-poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [emptyId] }) }, signal);
    expect(empty.output).toContain("Status: completed");
    expect(empty.output).toContain("=== Output ===\n(no output)");
    expect(empty.output).not.toContain("Process exited with code");
  });

  it("reports both the requested wait and native per-call cap", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new GrokBuildBrowserRuntime({
        vfs: new VirtualFS(),
        async run(_command, options) {
          return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: 130 }), { once: true }));
        },
      });
      const started = await runtime.execute({ callId: "wait-start", name: "run_terminal_command", arguments: '{"command":"forever","background":true}' }, signal);
      const id = /task ID: ([0-9a-f-]+)/u.exec(started.output)?.[1] ?? "";
      const pending = runtime.execute({ callId: "wait", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id], timeout_ms: 2_400_000 }) }, signal);
      await vi.advanceTimersByTimeAsync(600_000);
      const waited = await pending;
      expect(waited.output).toContain("Waited 600s, the per-call maximum, of the 2400s you requested; the task is still running. You do not need to call this again.");
      await runtime.execute({ callId: "wait-kill", name: "kill_command_or_subagent", arguments: JSON.stringify({ task_id: id }) }, signal);
    } finally {
      vi.useRealTimers();
    }
  });
});

function storedZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    put32(local, 0, 0x04034b50); put16(local, 4, 20); put16(local, 8, 0);
    put32(local, 18, data.length); put32(local, 22, data.length); put16(local, 26, nameBytes.length);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    put32(central, 0, 0x02014b50); put16(central, 4, 20); put16(central, 6, 20); put16(central, 10, 0);
    put32(central, 20, data.length); put32(central, 24, data.length); put16(central, 28, nameBytes.length); put32(central, 42, localOffset);
    central.set(nameBytes, 46); centrals.push(central); localOffset += local.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  put32(end, 0, 0x06054b50); put16(end, 8, centrals.length); put16(end, 10, centrals.length); put32(end, 12, centralSize); put32(end, 16, localOffset);
  return concat([...locals, ...centrals, end]);
}

function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function put16(bytes: Uint8Array, offset: number, value: number): void { bytes[offset] = value & 0xff; bytes[offset + 1] = value >>> 8; }
function put32(bytes: Uint8Array, offset: number, value: number): void { put16(bytes, offset, value); put16(bytes, offset + 2, value >>> 16); }
