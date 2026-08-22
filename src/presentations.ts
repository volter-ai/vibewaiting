import type { OverlayPresentation } from "@volter-ai-dev/widget-shell";

export const VIBEWAITING_PRESENTATION = Object.freeze({
  messenger: "messenger",
  terminal: "terminal",
} as const);

export type VibewaitingPresentation =
  (typeof VIBEWAITING_PRESENTATION)[keyof typeof VIBEWAITING_PRESENTATION];

/**
 * The messenger is deliberately phone-sized. A terminal needs enough physical columns and rows to
 * remain familiar, so it gets a wider desktop footprint while retaining Widget Shell's responsive
 * sheet/full-screen behavior on smaller browser viewports.
 */
export const VIBEWAITING_PRESENTATIONS = Object.freeze({
  [VIBEWAITING_PRESENTATION.messenger]: {
    footprint: {
      mode: "resizable",
      preferred: { width: 390, height: 667 },
    },
    viewport: { mode: "responsive" },
    surface: "auto",
  },
  [VIBEWAITING_PRESENTATION.terminal]: {
    footprint: {
      mode: "resizable",
      preferred: { width: 880, height: 520 },
    },
    viewport: { mode: "responsive" },
    surface: "auto",
  },
} satisfies Readonly<Record<VibewaitingPresentation, OverlayPresentation>>);
