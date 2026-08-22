import type {
  OverlayPresentation,
  PresentationSize,
} from "@volter-ai-dev/widget-shell";

export const VIBEWAITING_PRESENTATION = Object.freeze({
  messenger: "messenger",
  terminal: "terminal",
} as const);

export type VibewaitingPresentation =
  (typeof VIBEWAITING_PRESENTATION)[keyof typeof VIBEWAITING_PRESENTATION];

const TERMINAL_LIST_CHROME_HEIGHT = 112;
const TERMINAL_ROW_HEIGHT = 46;
const TERMINAL_LIST_MIN_HEIGHT = 260;
const TERMINAL_LIST_MAX_HEIGHT = 420;

/**
 * Terminal inventory is content-sized; a live PTY receives a stable, familiar terminal viewport.
 * Widget Shell applies host constraints and preserves a manual user resize above these requests.
 */
export function terminalPresentationSize(options: {
  attached: boolean;
  sessionCount: number;
}): PresentationSize {
  if (options.attached) return { width: 800, height: 420 };
  const visibleRows = Math.max(0, Math.min(8, Math.floor(options.sessionCount)));
  return {
    width: 720,
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
  [VIBEWAITING_PRESENTATION.terminal]: {
    footprint: {
      mode: "content-fit",
      preferred: { width: 720, height: 360 },
      min: { width: 560, height: 240 },
      max: { width: 880, height: 460 },
    },
    viewport: { mode: "responsive" },
    surface: "auto",
  },
} satisfies Readonly<Record<VibewaitingPresentation, OverlayPresentation>>);
