// Vibewaiting-specific guest composition only. Widget Shell owns the launcher, frame, geometry,
// clipping, and window chrome; Supercode owns every messenger component inside this viewport.
export const PANEL_CSS = `
:root { color-scheme:light dark }
html,body,#app { width:100%; height:100%; margin:0; overflow:hidden }
body { background:transparent }

.vw-dialog { --scui-bg:#fff; --scui-bg-raised:#f7f7f6; --scui-fill:#f1f1ef; --scui-fill-strong:#e7e7e3; --scui-fg:#191918;
  --scui-muted:#5f5f5a; --scui-border:#deded9; --scui-border-strong:#c7c7c0; --scui-danger:#b4232e;
  --scui-font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  position:relative; width:100%; height:100%; outline:0 }
.vw-messenger-layer { width:100%; height:100% }
.vw-messenger-layer > .scui-root {
  --scui-width:100%;
  --scui-height:100%;
  width:100%; height:100%; border:0; border-radius:0;
}

.vw-dialog:has(.vw-terminal-launch) .scui-head-copy { margin-right:38px }
.vw-terminal-launch { position:absolute; z-index:4; right:84px; top:10px; display:grid; width:30px; height:30px; place-items:center;
  padding:0; border:0; border-radius:8px; color:var(--scui-muted); background:transparent; font:600 11px/1 var(--scui-font); cursor:pointer }
.vw-terminal-launch:hover { color:var(--scui-fg); background:var(--scui-fill) }
.vw-terminal-launch > span { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
.vw-terminal-launch small { position:absolute; top:-4px; right:-5px; display:grid; min-width:14px; height:14px; place-items:center;
  padding:0 2px; border:2px solid var(--scui-bg-raised); border-radius:8px; background:var(--scui-muted); color:var(--scui-bg);
  font:700 8px/1 var(--scui-font) }

.vw-terminal-panel { position:absolute; inset:0; z-index:12; display:flex; flex-direction:column; box-sizing:border-box;
  color:var(--scui-fg); background:var(--scui-bg); font-family:var(--scui-font) }
.vw-terminal-panel > header { display:grid; grid-template-columns:32px minmax(0,1fr) auto; align-items:center; gap:7px;
  min-height:49px; padding:6px 10px; border-bottom:1px solid var(--scui-border); background:var(--scui-bg-raised) }
.vw-terminal-panel header span { display:flex; min-width:0; flex-direction:column; gap:2px }
.vw-terminal-panel header strong { font-size:13px; line-height:1.2 }
.vw-terminal-panel header small { overflow:hidden; color:var(--scui-muted); font-size:10px; text-overflow:ellipsis; white-space:nowrap }
.vw-terminal-panel button { min-height:28px; padding:4px 8px; border:1px solid var(--scui-border); border-radius:7px;
  color:var(--scui-fg); background:var(--scui-fill); font:600 11px/1.2 var(--scui-font); cursor:pointer }
.vw-terminal-panel button:hover:not(:disabled) { border-color:var(--scui-border-strong); background:var(--scui-fill-strong) }
.vw-terminal-panel button:disabled { opacity:.5; cursor:default }
.vw-terminal-panel header > button:first-child { padding:0; border-color:transparent; background:transparent; font-size:17px }
.vw-terminal-create { display:grid; grid-template-columns:1fr 1fr; gap:7px; padding:10px; border-bottom:1px solid var(--scui-border) }
.vw-terminal-create button { min-height:34px }
.vw-terminal-list { min-height:0; overflow:auto }
.vw-terminal-list article { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; align-items:center; gap:5px;
  padding:9px 10px; border-bottom:1px solid var(--scui-border) }
.vw-terminal-list article > span { display:flex; min-width:0; flex-direction:column; gap:3px }
.vw-terminal-list article strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.vw-terminal-list article strong { font-size:12px }
.vw-terminal-path { display:flex; min-width:0; overflow:hidden; color:var(--scui-muted); font-size:10px; font-style:normal; white-space:nowrap }
.vw-terminal-path > span { flex:0 1 auto; overflow:hidden; text-overflow:ellipsis }
.vw-terminal-path > i { flex:none; font-style:normal }
.vw-terminal-path > b { flex:none; max-width:58%; overflow:hidden; direction:rtl; font-weight:400; text-align:left; text-overflow:ellipsis; unicode-bidi:plaintext }
.vw-terminal-list .vw-danger { color:var(--scui-danger,#b94747); background:transparent }
.vw-terminal-error,.vw-terminal-empty { margin:10px; padding:9px; border:1px solid var(--scui-border); border-radius:8px;
  color:var(--scui-muted); background:var(--scui-bg-raised); font-size:11px; line-height:1.4 }
.vw-terminal-error { color:var(--scui-danger,#b94747) }
.vw-terminal-live { display:flex; min-height:0; flex:1; flex-direction:column; padding:8px; gap:7px; background:#111315 }
.vw-terminal-status { flex:none; color:#9ca3aa; font:500 10px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
.vw-terminal-screen { min-height:0; flex:1; overflow:auto }
.vw-terminal-screen .xterm { height:100% }
.vw-terminal-screen .xterm-viewport { overflow-y:auto }
.vw-terminal-live > button { align-self:flex-start; color:#e6e8ea; border-color:#363a3e; background:#222529 }

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
`;
