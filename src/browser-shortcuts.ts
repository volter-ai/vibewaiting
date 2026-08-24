export const BROWSER_SHORTCUTS = {
  focus: { mac: "⌥⇧V", other: "Alt+Shift+V" },
  attach: { mac: "⌥⇧A", other: "Alt+Shift+A" },
  previous: { mac: "⌥⇧←", other: "Alt+Shift+Left" },
  next: { mac: "⌥⇧→", other: "Alt+Shift+Right" },
} as const;

export type BrowserShortcut = keyof typeof BROWSER_SHORTCUTS;

export function browserShortcutLabel(
  shortcut: BrowserShortcut,
  platform = globalThis.navigator?.platform ?? "",
): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform)
    ? BROWSER_SHORTCUTS[shortcut].mac
    : BROWSER_SHORTCUTS[shortcut].other;
}
