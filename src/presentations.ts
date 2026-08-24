import type {
  OverlayPresentation,
} from "@volter-ai-dev/widget-shell";

export const VIBEWAITING_PRESENTATION = Object.freeze({
  messenger: "messenger",
  terminalList: "terminal-list",
  terminal: "terminal",
} as const);

export type VibewaitingPresentation =
  (typeof VIBEWAITING_PRESENTATION)[keyof typeof VIBEWAITING_PRESENTATION];

const TERMINAL_LOGICAL_SIZE = Object.freeze({ width: 760, height: 430 });

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
  [VIBEWAITING_PRESENTATION.terminalList]: {
    // Compatibility alias for persisted Widget Shell presentation memory from the former picker.
    footprint: { mode: "resizable", preferred: TERMINAL_LOGICAL_SIZE },
    viewport: {
      mode: "virtual",
      ...TERMINAL_LOGICAL_SIZE,
      allowUpscale: true,
      minimumScale: 0.65,
    },
    surface: "auto",
  },
  [VIBEWAITING_PRESENTATION.terminal]: {
    footprint: {
      mode: "resizable",
      preferred: TERMINAL_LOGICAL_SIZE,
    },
    // Keep the familiar terminal grid stable. The shell's ordinary resize handle changes the
    // physical footprint, so the complete terminal scales up or down instead of silently changing
    // its simulated rows and columns.
    viewport: {
      mode: "virtual",
      ...TERMINAL_LOGICAL_SIZE,
      allowUpscale: true,
      minimumScale: 0.65,
    },
    surface: "auto",
  },
} satisfies Readonly<Record<VibewaitingPresentation, OverlayPresentation>>);
