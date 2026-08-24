// Vibewaiting-specific guest composition only. Widget Shell owns the launcher, frame, geometry,
// clipping, and window chrome; Supercode owns every messenger component inside this viewport.
export const PANEL_CSS = `
:root { color-scheme:light dark }
html,body,#app { width:100%; height:100%; margin:0; overflow:hidden }
body { background:transparent }

.vw-dialog { --scui-bg:#fff; --scui-bg-raised:#f7f7f6; --scui-fill:#f1f1ef; --scui-fill-strong:#e7e7e3; --scui-fg:#191918;
  --scui-muted:#5f5f5a; --scui-border:#deded9; --scui-border-strong:#c7c7c0; --scui-danger:#b4232e;
  --sctui-terminal-background:rgba(17,19,21,.78);
  --scui-font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  position:relative; width:100%; height:100%; outline:0 }
.vw-messenger-layer { width:100%; height:100% }
.vw-messenger-layer > .scui-root {
  --scui-width:100%;
  --scui-height:100%;
  width:100%; height:100%; border:0; border-radius:0;
}

.vw-terminal-launch { position:relative; display:grid; width:30px; height:30px; place-items:center;
  padding:0; border:0; border-radius:8px; color:var(--scui-muted); background:transparent; font:600 11px/1 var(--scui-font); cursor:pointer }
.vw-terminal-launch:hover { color:var(--scui-fg); background:var(--scui-fill) }
.vw-terminal-launch > span { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
.vw-terminal-launch small { position:absolute; top:-4px; right:-5px; display:grid; min-width:14px; height:14px; place-items:center;
  padding:0 2px; border:2px solid var(--scui-bg-raised); border-radius:8px; background:var(--scui-muted); color:var(--scui-bg);
  font:700 8px/1 var(--scui-font) }

.vw-shortcut-launch { display:grid; width:30px; height:30px; place-items:center; padding:0; border:0; border-radius:8px;
  color:var(--scui-muted); background:transparent; cursor:pointer }
.vw-shortcut-launch:hover,.vw-shortcut-launch:focus-visible { color:var(--scui-fg); background:var(--scui-fill); outline:0 }
.vw-shortcut-launch svg { display:block; width:16px; height:16px }
.vw-shortcut-help { width:min(300px,calc(100vw - 28px)); margin:auto; padding:16px; border:1px solid var(--scui-border-strong);
  border-radius:12px; color:var(--scui-fg); background:var(--scui-bg); box-shadow:0 18px 50px rgba(16,24,40,.22);
  font-family:var(--scui-font) }
.vw-shortcut-help::backdrop { background:rgba(15,23,42,.26); backdrop-filter:blur(2px) }
.vw-shortcut-help > strong { display:block; font-size:14px }
.vw-shortcut-help > small { display:block; margin:3px 0 12px; color:var(--scui-muted); font-size:11px }
.vw-shortcut-help dl { display:grid; margin:0 0 12px }
.vw-shortcut-help dl div { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--scui-border) }
.vw-shortcut-help dt,.vw-shortcut-help dd { margin:0; font-size:11px }
.vw-shortcut-help kbd { padding:3px 6px; border:1px solid var(--scui-border-strong); border-radius:5px; background:var(--scui-fill);
  font:650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace }
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

@media (prefers-color-scheme:dark) {
  .vw-dialog { --scui-bg:#151515; --scui-bg-raised:#1c1c1b; --scui-fill:#242422; --scui-fill-strong:#30302d;
    --scui-fg:#f3f3ef; --scui-muted:#a3a39d; --scui-border:#353532; --scui-border-strong:#4a4a45; --scui-danger:#ff747d }
}
.vw-presentation-error { position:absolute; z-index:20; right:12px; bottom:12px; left:12px; padding:10px 12px;
  border:1px solid color-mix(in srgb, #b42318 36%, transparent); border-radius:10px; color:#7a271a;
  background:#fffbfa; box-shadow:0 8px 24px rgba(16,24,40,.14); font:500 12px/1.4 var(--scui-font) }
`;
