// Vibewaiting-specific composition CSS only. Supercode owns all messenger component styling;
// these rules adapt its neutral tokens to Lucarne and shape Lucarne's launcher/panel chrome.
export const PANEL_CSS = `
.wrap { width:max-content }
.panel { width:var(--vw-panel-width,420px) }
.panel > header { display:none }
.panel { animation-duration:.18s }

.vw-dialog { width:var(--vw-panel-width,420px); height:var(--vw-panel-height,480px); outline:0 }
.vw-dialog > .scui-root {
  --scui-width:var(--vw-panel-width,420px);
  --scui-height:var(--vw-panel-height,480px);
  --scui-bg:var(--bg);
  --scui-bg-raised:var(--bg2);
  --scui-fill:var(--fill);
  --scui-fg:var(--fg);
  --scui-muted:var(--mut);
  --scui-border:var(--hair);
  --scui-border-strong:var(--bd);
  --scui-accent:var(--acc);
  --scui-positive:var(--ok);
  --scui-warning:var(--ask);
  --scui-danger:var(--block);
  width:100%; height:100%; border:0; border-radius:0;
}

/* Lucarne owns the collapsed control; Supercode supplies its canonical harness identity. */
.pill { position:relative; box-sizing:border-box; width:56px; height:56px; justify-content:center; margin:4px; padding:0; border:0;
  border-radius:50%; background:transparent; overflow:visible; animation:none }
.pill[hidden] { display:none }
.pill:hover { border-color:transparent; background:var(--fill) }
.pill:focus-visible { outline:2px solid var(--acc); outline-offset:-3px }
.pill .brand { position:relative; display:grid; place-items:center }
.pill .brand .scui-logo { box-shadow:0 1px 4px rgba(0,0,0,.22); transition:transform .16s ease }
.pill:hover .brand .scui-logo { transform:scale(1.05) }
.pill .lead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
.pill .triad { position:absolute; inset:0; margin:0; padding:0; pointer-events:none }
.pill .triad .oi.dot { display:none }
.pill .triad .oi.badge { position:absolute; top:1px; right:1px; box-sizing:border-box; min-width:18px; height:18px; padding:0 4px;
  border:1.5px solid var(--bg); border-radius:9px; background:var(--block); box-shadow:0 1px 4px rgba(0,0,0,.28) }
.pill:is([data-mode="connecting"],[data-mode="working"]) .brand::after { content:""; position:absolute; inset:-4px;
  border:2px solid color-mix(in srgb,var(--acc) 28%,transparent); border-top-color:var(--acc); border-radius:50%; animation:vw-spin .8s linear infinite }
.pill:is([data-mode="needs-input"],[data-mode="error"]) .triad .oi.dot { position:absolute; right:1px; bottom:1px;
  display:grid; place-items:center; box-sizing:border-box; width:18px; height:18px; border:1.5px solid var(--bg); border-radius:50%; box-shadow:0 1px 4px rgba(0,0,0,.28); animation:none }
.pill[data-mode="needs-input"] .triad .oi.dot { border-color:var(--bg); background:var(--ask); color:var(--bg) }
.pill[data-mode="needs-input"] .triad .oi.dot::before { content:"!"; font-size:11px; font-weight:800; line-height:1 }
.pill[data-mode="error"] .triad .oi.dot { border-color:var(--bg); background:var(--block); color:#fff }
.pill[data-mode="error"] .triad .oi.dot::before { content:"×"; font-size:14px; font-weight:700; line-height:1 }
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) .triad .oi.badge { display:none }

@keyframes vw-spin { to { transform:rotate(360deg) } }
@media (prefers-reduced-motion:reduce) {
  .pill:is([data-mode="connecting"],[data-mode="working"]) .brand::after { animation:none }
}
`;
