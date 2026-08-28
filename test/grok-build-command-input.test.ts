import { describe, expect, it } from "vitest";
import { VirtualFS } from "almostnode";
import {
  parseGrokLenientU64,
  selfMatchingPkillError,
} from "../experiments/browser-agent/src/grok-build-command-input.js";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

// Source-derived corpus: xai-grok-tools grok_build/bash/mod.rs and
// types/schema.rs at pinned native revision 9684fa3c.
describe("Grok Build terminal input parity", () => {
  it("accepts native lenient u64 forms and rejects non-whole or non-numeric values", () => {
    expect(parseGrokLenientU64(1_000)).toBe(1_000);
    expect(parseGrokLenientU64("1000")).toBe(1_000);
    expect(parseGrokLenientU64("1000.0")).toBe(1_000);
    expect(parseGrokLenientU64("1e3")).toBe(1_000);
    expect(parseGrokLenientU64(-0)).toBe(-0);
    expect(() => parseGrokLenientU64(" 1000 ")).toThrow('expected number, got string " 1000 "');
    expect(() => parseGrokLenientU64("nope")).toThrow('expected number, got string "nope"');
    expect(() => parseGrokLenientU64(1.5)).toThrow("expected whole number");
    expect(() => parseGrokLenientU64(-1)).toThrow("expected non-negative number");
    expect(() => parseGrokLenientU64(true)).toThrow("expected number");
  });

  it("ports native self-matching pkill and destructive pgrep detection", () => {
    const rejected = [
      "pkill -f ./clavitor-web && sleep 0.5 && ./clavitor-web > log 2>&1",
      "pkill -f './clavitor-web' && nohup ./clavitor-web > log 2>&1",
      'pkill -f "myserver" ; ./myserver --foo',
      "pgrep -f ./server | xargs -r kill ; ./server &",
      "pkill -fe ./server && ./server",
      "pkill --full ./server && ./server",
    ];
    for (const command of rejected) expect(selfMatchingPkillError(command)).toContain("self-matching");

    const allowed = [
      "pkill -f ./clavitor-web",
      "pkill -x clavitor-web && ./clavitor-web",
      "pkill -f ./otherserver && ./clavitor-web",
      'pkill -f "$(cat pidpat)" && ./clavitor-web',
      "xpkill -f ./server && ./server",
      "pgrep -f ./server && echo found",
      "pkill -f a && echo a",
    ];
    for (const command of allowed) expect(selfMatchingPkillError(command)).toBeUndefined();
  });

  it("enforces required description, accepts numeric-string timeout, and maps foreground zero to default", async () => {
    const calls: Array<{ command: string; aborted: boolean }> = [];
    const runtime = new GrokBuildBrowserRuntime({
      vfs: new VirtualFS(),
      async run(command, options) {
        calls.push({ command, aborted: options?.signal?.aborted ?? false });
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    const signal = new AbortController().signal;
    const execute = (argumentsJson: string) => runtime.execute({
      callId: crypto.randomUUID(), name: "run_terminal_command", arguments: argumentsJson,
    }, signal);

    await expect(execute('{"command":"echo ok","timeout":1000}')).resolves.toEqual({
      isError: true, output: "missing field `description`",
    });
    await expect(execute('{"command":"echo ok","description":"Print value","timeout":"1000.0"}')).resolves.toEqual({ output: "exit: 0\nok" });
    await expect(execute('{"command":"echo ok","description":"Print value","timeout":0}')).resolves.toEqual({ output: "exit: 0\nok" });
    await expect(execute('{"command":"pkill -f ./server && ./server","description":"Restart server"}')).resolves.toMatchObject({
      isError: true, output: expect.stringContaining("self-matching pkill/-f"),
    });
    expect(calls).toHaveLength(2);
  });
});
