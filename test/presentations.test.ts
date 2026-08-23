import { resolvePresentationSnapshot } from "@volter-ai-dev/widget-shell/core";
import { describe, expect, it } from "vitest";
import {
  VIBEWAITING_PRESENTATION,
  VIBEWAITING_PRESENTATIONS,
} from "../src/presentations.js";

describe("terminal presentation", () => {
  it("scales one stable logical terminal instead of reflowing its grid", () => {
    const presentation =
      VIBEWAITING_PRESENTATIONS[VIBEWAITING_PRESENTATION.terminal];
    const snapshot = resolvePresentationSnapshot({
      authority: "user",
      name: VIBEWAITING_PRESENTATION.terminal,
      physical: { width: 512, height: 320 },
      presentation,
      requested: { width: 640, height: 400 },
      surface: "floating",
    });

    expect(snapshot).toMatchObject({
      logical: { width: 640, height: 400 },
      rendered: { width: 512, height: 320 },
      scale: 0.8,
      viewport: "virtual",
    });
  });
});
