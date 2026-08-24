import { describe, expect, it } from "vitest";
import {
  matchingDevelopmentBrowserPort,
  parseDevelopmentBrowserProcesses,
} from "../src/dev-browser-selection.js";

describe("development browser selection", () => {
  it("selects the exact checkout instead of another extension with the same id", () => {
    const processes = parseDevelopmentBrowserProcesses([
      "/Applications/Brave --remote-debugging-port=49160 --load-extension=/work/old/dist/extension https://example.com",
      "/Applications/Brave --remote-debugging-port=49161 --load-extension=/work/current/dist/extension https://example.com",
      "/Applications/Brave Helper --remote-debugging-port=49161 --type=renderer",
    ].join("\n"));

    expect(processes).toEqual([
      { port: 49160, extensions: ["/work/old/dist/extension"] },
      { port: 49161, extensions: ["/work/current/dist/extension"] },
    ]);
    expect(
      matchingDevelopmentBrowserPort(processes, "/work/current/dist/extension"),
    ).toBe(49161);
  });
});
