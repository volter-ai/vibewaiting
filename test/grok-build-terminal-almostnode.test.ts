import { createContainer } from "almostnode";
import { describe, expect, it } from "vitest";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

// Browser-runtime proof for the subset of native Bash semantics AlmostNode can
// represent. OS process groups/signals remain covered as an explicit residual.
describe("Grok Build terminal over AlmostNode", () => {
  it("preserves cwd, sequential redirection, append, and the native exit header", async () => {
    const container = createContainer();
    container.vfs.mkdirSync("/game", { recursive: true });
    const runtime = new GrokBuildBrowserRuntime(container, "/game");
    const result = await runtime.execute({
      callId: "redirect",
      name: "run_terminal_command",
      arguments: JSON.stringify({
        command: "printf 'first\\n' > score.txt && printf 'second\\n' >> score.txt && cat score.txt",
        description: "Verify generated score output",
        timeout: 5_000,
      }),
    }, new AbortController().signal);

    expect(result).toEqual({ output: "exit: 0\nfirst\nsecond\n" });
    expect(container.vfs.readFileSync("/game/score.txt", "utf8")).toBe("first\nsecond\n");
  });

  it("accepts native empty commands and keeps nonzero exit codes model-visible", async () => {
    const container = createContainer();
    container.vfs.writeFileSync("/broken.js", "export const = ;");
    const runtime = new GrokBuildBrowserRuntime(container);
    const signal = new AbortController().signal;
    await expect(runtime.execute({
      callId: "empty", name: "run_terminal_command",
      arguments: '{"command":"","description":"No-op"}',
    }, signal)).resolves.toEqual({ output: "exit: 0" });
    await expect(runtime.execute({
      callId: "failure", name: "run_terminal_command",
      arguments: '{"command":"node --check broken.js","description":"Exercise failure","timeout":5000}',
    }, signal)).resolves.toMatchObject({ output: expect.stringMatching(/^exit: 1\n/u) });
  });
});
