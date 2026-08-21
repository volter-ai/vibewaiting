// Vibewaiting-specific guest composition only. Widget Shell owns the launcher, frame, geometry,
// clipping, and window chrome; Supercode owns every messenger component inside this viewport.
export const PANEL_CSS = `
:root { color-scheme:light dark }
html,body,#app { width:100%; height:100%; margin:0; overflow:hidden }
body { background:#14161c }

.vw-dialog { position:relative; width:100%; height:100%; outline:0 }
.vw-dialog > .scui-root {
  --scui-width:100%;
  --scui-height:100%;
  --scui-bg:#14161c;
  width:100%; height:100%; border:0; border-radius:0;
}
:root[data-theme="light"] body { background:#f8f9fb }
:root[data-theme="light"] .vw-dialog > .scui-root { --scui-bg:#f8f9fb }

.vw-bridge-disconnected { position:absolute; inset:0; z-index:20; display:grid; place-content:center; justify-items:center; gap:8px;
  box-sizing:border-box; padding:28px; text-align:center; color:var(--scui-fg); background:color-mix(in srgb,var(--scui-bg-raised) 94%,transparent); backdrop-filter:blur(8px) }
.vw-bridge-disconnected strong { font-size:15px }
.vw-bridge-disconnected small { max-width:260px; color:var(--scui-muted); line-height:1.45 }
.vw-bridge-disconnected span { display:flex; gap:7px; margin-top:6px }
.vw-bridge-disconnected button { margin-top:6px; padding:7px 14px; border:1px solid var(--scui-border-strong); border-radius:8px; color:var(--scui-fg); background:var(--scui-fill); cursor:pointer }
.vw-bridge-disconnected span button { margin-top:0 }
.vw-bridge-disconnected button:disabled { opacity:.55; cursor:default }
.vw-bridge-disconnected .vw-secondary { border-color:transparent; background:transparent; color:var(--scui-muted) }
`;
