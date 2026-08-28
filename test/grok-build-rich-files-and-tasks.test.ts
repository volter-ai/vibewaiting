import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

const signal = new AbortController().signal;

describe("Grok Build rich browser file reads", () => {
  it("attaches native-shaped image function output instead of treating bytes as text", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/frame.png", Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAvSURBVFiF7c4xAQAwDIAwNv+eWxl9ggHypqbD/uUcAAAAAAAAAAAAAAAAAACgagEw4wI+0ujnJgAAAABJRU5ErkJggg==", "base64")));
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    await expect(runtime.execute({ callId: "image", name: "read_file", arguments: '{"target_file":"/frame.png"}' }, signal)).resolves.toMatchObject({
      output: "Read image file: /frame.png",
      images: [expect.stringMatching(/^data:image\/png;base64,/u)],
    });
  });

  it("extracts ordered PPTX slide and notes text entirely in the browser", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/deck.pptx", storedZip({
      "ppt/slides/slide10.xml": '<p:sld xmlns:a="a"><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
      "ppt/slides/slide2.xml": '<p:sld xmlns:a="a"><a:p><a:r><a:t>Two &amp; more</a:t></a:r></a:p></p:sld>',
      "ppt/notesSlides/notesSlide2.xml": '<p:notes xmlns:a="a"><a:p><a:r><a:t>Remember this</a:t></a:r></a:p></p:notes>',
    }));
    const runtime = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } });

    const result = await runtime.execute({ callId: "pptx", name: "read_file", arguments: '{"target_file":"/deck.pptx"}' }, signal);
    expect(result.output).toBe("1→--- Slide 2 ---\n2→Two & more\n3→\n4→Speaker Notes:\n5→Remember this\n6→\n7→--- Slide 10 ---\n8→Ten");
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
