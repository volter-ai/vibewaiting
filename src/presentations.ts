import type {
  OverlayPresentation,
  PresentationSize,
} from "@volter-ai-dev/widget-shell";

export const VIBEWAITING_PRESENTATION = Object.freeze({
  messenger: "messenger",
  terminalList: "terminal-list",
  terminal: "terminal",
} as const);

export type VibewaitingPresentation =
  (typeof VIBEWAITING_PRESENTATION)[keyof typeof VIBEWAITING_PRESENTATION];

const TERMINAL_LIST_CHROME_HEIGHT = 92;
const TERMINAL_ROW_HEIGHT = 46;
const TERMINAL_LIST_MIN_HEIGHT = 220;
const TERMINAL_LIST_MAX_HEIGHT = 400;
const TERMINAL_LOGICAL_SIZE = Object.freeze({ width: 640, height: 400 });

/**
 * Terminal inventory is content-sized. Its live PTY uses the separate stable virtual viewport
 * below, so adding a session never changes the scale of an attached terminal.
 */
export function terminalListPresentationSize(
  sessionCount: number,
): PresentationSize {
  const visibleRows = Math.max(0, Math.min(8, Math.floor(sessionCount)));
  return {
    width: 600,
    height: Math.max(
      TERMINAL_LIST_MIN_HEIGHT,
      Math.min(
        TERMINAL_LIST_MAX_HEIGHT,
        TERMINAL_LIST_CHROME_HEIGHT + visibleRows * TERMINAL_ROW_HEIGHT,
      ),
    ),
  };
}

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
    footprint: {
      mode: "content-fit",
      preferred: { width: 600, height: 320 },
      min: { width: 480, height: TERMINAL_LIST_MIN_HEIGHT },
      max: { width: 680, height: TERMINAL_LIST_MAX_HEIGHT },
    },
    viewport: { mode: "responsive" },
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
      minimumScale: 0.75,
    },
    surface: "auto",
  },
} satisfies Readonly<Record<VibewaitingPresentation, OverlayPresentation>>);
