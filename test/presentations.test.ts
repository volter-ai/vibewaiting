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
      requested: { width: 760, height: 430 },
      surface: "floating",
    });

    expect(snapshot).toMatchObject({
      logical: { width: 760, height: 430 },
      rendered: { width: 512, height: 289.6842105263158 },
      scale: 0.6736842105263158,
      viewport: "virtual",
    });
  });

  it("lets a fitted terminal reflow to the physical viewport", () => {
    const presentation =
      VIBEWAITING_PRESENTATIONS[VIBEWAITING_PRESENTATION.terminalFit];
    const snapshot = resolvePresentationSnapshot({
      authority: "guest",
      name: VIBEWAITING_PRESENTATION.terminalFit,
      physical: { width: 512, height: 320 },
      presentation,
      requested: { width: 760, height: 430 },
      surface: "floating",
    });

    expect(snapshot).toMatchObject({
      logical: { width: 512, height: 320 },
      rendered: { width: 512, height: 320 },
      scale: 1,
      viewport: "responsive",
    });
  });
});
