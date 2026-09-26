import { brandCss } from "../scripts/brand.mjs";

// Colours, shadows and fonts are the Volter brand's roles (`brand(<role>)`), resolved when a build
// imports this module (scripts/brand.mjs).
// Vibewaiting-specific guest composition only. Widget Shell owns the launcher, frame, geometry,
// clipping, and window chrome; Supercode owns every messenger component inside this viewport.
export const PANEL_CSS = brandCss(`
:root { color-scheme:light dark }
html,body,#app { width:100%; height:100%; margin:0; overflow:hidden }
body { background:transparent }

.vw-dialog { --scui-bg:brand(surface.page); --scui-bg-raised:brand(surface.raised); --scui-fill:brand(surface.subtle); --scui-fill-strong:brand(surface.inset); --scui-fg:brand(text.primary);
  --scui-muted:brand(text.muted); --scui-border:brand(border.default); --scui-border-strong:brand(border.strong); --scui-danger:brand(status.danger.base);
  --sctui-terminal-background:brand(surface.media);
  --scui-font:brand(font.ui);
  position:relative; width:100%; height:100%; outline:0 }
.vw-messenger-layer { width:100%; height:100% }
.vw-messenger-layer > .scui-root {
  --scui-width:100%;
  --scui-height:100%;
  width:100%; height:100%; border:0; border-radius:0;
}
.vw-dialog[data-terminal="true"] .scui-root > section > :not(.scui-head) { visibility:hidden; pointer-events:none }

.vw-mode-toggle { display:flex; height:26px; flex:none; align-items:center; padding:2px; border:1px solid var(--scui-border);
  border-radius:7px; background:var(--scui-fill) }
.vw-mode-toggle button { position:relative; display:grid; width:26px; height:22px; place-items:center; padding:0; border:0;
  border-radius:5px; color:var(--scui-muted); background:transparent; cursor:pointer }
.vw-mode-toggle button[aria-pressed="true"] { color:var(--scui-fg); background:var(--scui-bg); box-shadow:brand(shadow.resting) }
.vw-mode-toggle button:disabled { opacity:.42; cursor:default }
.vw-mode-toggle svg { display:block; width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8;
  stroke-linecap:round; stroke-linejoin:round }

.vw-compose-chat { display:grid; width:31px; height:31px; flex:none; place-items:center; padding:0;
  border:0; border-radius:7px; color:var(--scui-muted); background:transparent; cursor:pointer }
.vw-compose-chat:hover,.vw-compose-chat:focus-visible { color:var(--scui-fg); background:var(--scui-fill); outline:0 }
.vw-compose-chat:disabled { opacity:.4; cursor:default }

.vw-native-move { display:flex; align-items:center; gap:10px; margin:7px 9px 2px; padding:7px 9px;
  border:1px solid var(--scui-border); border-radius:9px; color:var(--scui-fg); background:var(--scui-bg-raised) }
.vw-native-move strong { min-width:0; flex:1; overflow:hidden; font:650 10.5px/1.25 var(--scui-font);
  text-overflow:ellipsis; white-space:nowrap }
.vw-native-move button { flex:none; padding:6px 8px; border:1px solid var(--scui-border-strong); border-radius:7px;
  color:var(--scui-fg); background:var(--scui-bg); font:650 9.5px/1 var(--scui-font); cursor:pointer }
.vw-native-move button:hover,.vw-native-move button:focus-visible { background:var(--scui-fill); outline:0 }
.vw-native-move button:disabled { opacity:.45; cursor:default }

.vw-terminal-surface { position:absolute; z-index:11; top:49px; right:0; bottom:0; left:0; display:flex; min-width:0; min-height:0;
  box-sizing:border-box; padding:5px 7px 7px; background:var(--sctui-terminal-background); color:brand(terminal.white); color-scheme:dark }
.vw-terminal-surface > .sctui-viewer { min-width:0; min-height:0; flex:1 }

.vw-shortcut-help { width:min(300px,calc(100vw - 28px)); margin:auto; padding:16px; border:1px solid var(--scui-border-strong);
  border-radius:12px; color:var(--scui-fg); background:var(--scui-bg); box-shadow:brand(shadow.dialog);
  font-family:var(--scui-font) }
.vw-shortcut-help::backdrop { background:brand(overlay.scrim); backdrop-filter:blur(2px) }
.vw-shortcut-help > strong { display:block; font-size:14px }
.vw-shortcut-help > small { display:block; margin:3px 0 12px; color:var(--scui-muted); font-size:11px }
.vw-shortcut-help dl { display:grid; margin:0 0 12px }
.vw-shortcut-help dl div { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--scui-border) }
.vw-shortcut-help dt,.vw-shortcut-help dd { margin:0; font-size:11px }
.vw-shortcut-help kbd { padding:3px 6px; border:1px solid var(--scui-border-strong); border-radius:5px; background:var(--scui-fill);
  font:650 10px/1.2 brand(font.data) }
.vw-shortcut-help > button { width:100%; padding:8px; border:1px solid transparent; border-radius:8px; color:var(--scui-muted);
  background:transparent; font:600 11px/1 var(--scui-font); cursor:pointer }
.vw-shortcut-help > button:hover,.vw-shortcut-help > button:focus-visible { color:var(--scui-fg); background:var(--scui-fill); outline:0 }

.vw-bridge-disconnected { position:absolute; inset:0; z-index:20; display:grid; place-content:center; justify-items:center; gap:8px;
  box-sizing:border-box; padding:28px; text-align:center; color:var(--scui-fg); background:color-mix(in srgb,var(--scui-bg-raised) 94%,transparent); backdrop-filter:blur(8px) }
.vw-bridge-disconnected strong { font-size:15px }
.vw-bridge-disconnected small { max-width:260px; color:var(--scui-muted); line-height:1.45 }
.vw-bridge-disconnected span { display:flex; gap:7px; margin-top:6px }
.vw-bridge-disconnected button { margin-top:6px; padding:7px 14px; border:1px solid var(--scui-border-strong); border-radius:8px; color:var(--scui-fg); background:var(--scui-fill); cursor:pointer }
.vw-bridge-disconnected span button { margin-top:0 }
.vw-bridge-disconnected button:disabled { opacity:.55; cursor:default }
.vw-bridge-disconnected .vw-secondary { border-color:transparent; background:transparent; color:var(--scui-muted) }

.vw-approvals { --vw-approval-bg:brand(surface.raised); --vw-approval-fg:brand(text.primary); --vw-approval-muted:brand(text.muted); --vw-approval-border:brand(border.strong);
  --vw-approval-accent:brand(status.attention.base);
  position:fixed; z-index:25; top:56px; right:10px; left:10px; display:grid; gap:8px; pointer-events:none;
  font-family:brand(font.ui) }
.vw-approval { display:grid; gap:6px; padding:12px; border:1px solid var(--vw-approval-border); border-left:3px solid var(--vw-approval-accent);
  border-radius:10px; color:var(--vw-approval-fg); background:var(--vw-approval-bg); box-shadow:brand(shadow.floating); pointer-events:auto }
.vw-approval-head { display:flex; align-items:center; gap:6px; color:var(--vw-approval-accent) }
.vw-approval-head svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round }
.vw-approval-head small { font-weight:600; font-size:10.5px; line-height:1.2; letter-spacing:.02em; text-transform:uppercase }
.vw-approval strong { font-weight:650; font-size:13.5px; line-height:1.3; overflow-wrap:anywhere }
.vw-approval p { margin:0; color:var(--vw-approval-muted); font-weight:400; font-size:11.5px; line-height:1.4 }
.vw-approval-actions { display:flex; justify-content:flex-end; gap:6px; margin-top:4px }
.vw-approval-actions button { padding:7px 12px; border:1px solid var(--vw-approval-border); border-radius:7px; font-weight:650; font-size:11.5px; line-height:1; cursor:pointer }
.vw-approval-deny { color:var(--vw-approval-fg); background:var(--vw-approval-bg) }
.vw-approval-approve { border-color:transparent !important; color:brand(text.inverse); background:var(--vw-approval-fg) }
.vw-approval-actions button:hover,.vw-approval-actions button:focus-visible { outline:2px solid var(--vw-approval-accent); outline-offset:1px }
.vw-approval-actions button:disabled,.vw-approval-actions button[aria-disabled="true"] { opacity:.55; cursor:default; outline:0 }
.vw-approval-actions { flex-wrap:wrap }
.vw-approval .vw-approval-status { color:var(--vw-approval-fg); font-weight:600 }
.vw-approvals-notice { margin:0; padding:9px 11px; border:1px solid var(--vw-approval-border); border-radius:10px;
  color:var(--vw-approval-fg); background:var(--vw-approval-bg); box-shadow:brand(shadow.floating);
  font-size:12px; line-height:1.4; pointer-events:auto }
.vw-approval .vw-approval-hint { min-height:1.4em; overflow:hidden; color:var(--vw-approval-accent); font-weight:600; white-space:nowrap; text-overflow:ellipsis }

@media (max-width:640px) {
  .vw-terminal-surface { top:52px }
}
.vw-presentation-error { position:absolute; z-index:20; right:12px; bottom:12px; left:12px; padding:10px 12px;
  border:1px solid brand(status.danger.line); border-radius:10px; color:brand(status.danger.text);
  background:brand(status.danger.soft); box-shadow:brand(shadow.floating); font:500 12px/1.4 var(--scui-font) }
`);
