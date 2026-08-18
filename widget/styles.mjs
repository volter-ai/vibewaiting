// App-specific layout and presentation. All color comes from Lucarne's adaptive shell tokens, so
// this keeps VGAI's information architecture without inheriting VGAI's editor backdrop/theme.
export const PANEL_CSS = `
/* One app, one messenger: remove Lucarne's redundant single-tab toolbar and let the app header
   carry navigation/close semantics. The collapsed surface uses Lucarne's 80px safe host minimum
   as an intentional compact capsule instead of leaving a small button stranded in empty glass. */
.wrap { width:max-content }
.panel { width:var(--vw-panel-width,420px) }
.panel > header { display:none }
.pill,.panel { animation-duration:.18s }
.pill { position:relative; width:80px; height:48px; justify-content:center; gap:8px; padding:0; border:0;
  background:transparent; transition:background-color .14s,width .18s ease; overflow:hidden }
.pill:hover { border-color:transparent; background:var(--fill) }
.pill:focus-visible { outline:2px solid var(--acc); outline-offset:-3px }
.pill .brand { display:grid; place-items:center }
.pill .brand .vw-harness-logo { box-shadow:0 1px 4px rgba(0,0,0,.22); transition:transform .16s ease }
.pill:hover .brand .vw-harness-logo { transform:scale(1.05) }
.pill .lead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
.pill .triad { position:absolute; inset:0; margin:0; padding:0; pointer-events:none }
.pill .triad .oi.dot { display:none }
.pill .triad .oi.badge { position:absolute; top:4px; right:7px; min-width:17px; height:17px; padding:0 4px;
  border:1.5px solid var(--bg); border-radius:9px; background:var(--block); box-shadow:0 1px 4px rgba(0,0,0,.28) }

/* Work, connection, and blocked states become a concise status capsule. Passive unread activity
   remains compact and uses only the familiar badge, like a minimized messenger launcher. */
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) {
  width:auto; min-width:80px; max-width:250px; justify-content:flex-start; padding:7px 11px 7px 8px }
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) .lead {
  position:static; width:auto; height:auto; min-width:0; max-width:174px; overflow:hidden; clip-path:none;
  color:var(--fg); font-size:11.5px; font-weight:600; text-overflow:ellipsis }
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) .triad {
  position:static; inset:auto; display:inline-flex; margin-left:auto; padding-left:1px }
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) .triad .oi.dot {
  display:block; width:13px; height:13px; border-width:2px; background:transparent; box-shadow:none; animation:none }
.pill[data-mode="connecting"] .triad .oi.dot,
.pill[data-mode="working"] .triad .oi.dot { border-color:color-mix(in srgb,var(--acc) 28%,transparent); border-top-color:var(--acc); animation:vw-spin .8s linear infinite }
.pill[data-mode="needs-input"] .triad .oi.dot { display:grid; place-items:center; border:0; color:var(--ask) }
.pill[data-mode="needs-input"] .triad .oi.dot::before { content:"!"; font-size:13px; font-weight:800; line-height:1 }
.pill[data-mode="error"] .triad .oi.dot { display:grid; place-items:center; border:0; color:var(--block) }
.pill[data-mode="error"] .triad .oi.dot::before { content:"×"; font-size:17px; font-weight:700; line-height:1 }
.pill:is([data-mode="connecting"],[data-mode="working"],[data-mode="needs-input"],[data-mode="error"]) .triad .oi.badge { display:none }
.vw-screen,.vw-chat { display:flex; flex-direction:column; height:var(--vw-panel-height,480px); min-height:280px }
.vw-chat { position:relative }

/* app header */
.vw-app-head { min-height:48px; display:flex; align-items:center; gap:6px; padding:5px 8px 5px 10px;
  border-bottom:1px solid var(--hair) }
.vw-head-copy { min-width:0; flex:1; display:flex; flex-direction:column; line-height:1.18 }
.vw-head-copy strong { overflow:hidden; color:var(--fg); font-size:13px; font-weight:650; text-overflow:ellipsis; white-space:nowrap }
.vw-head-copy small { overflow:hidden; color:var(--mut); font-size:10px; text-overflow:ellipsis; white-space:nowrap }
.vw-head-copy small[data-state="working"] { color:var(--acc) }
.vw-head-copy small[data-state="needs-input"] { color:var(--ask) }
.vw-icon { display:inline-grid; place-items:center; width:28px; height:28px; flex:none; padding:0; border:0;
  border-radius:8px; background:transparent; color:var(--mut); font:16px/1 inherit; cursor:pointer }
.vw-icon:hover { background:var(--fill); color:var(--fg) }
.vw-icon:disabled { opacity:.35; cursor:default }
.vw-icon:focus-visible,.vw-latest:focus-visible,.vw-send:focus-visible,.vw-stop:focus-visible { outline:2px solid var(--acc); outline-offset:-2px }

/* session list */
.vw-list { min-height:0; flex:1; display:flex; flex-direction:column; overflow-y:auto; overscroll-behavior:contain;
  padding:6px 6px 10px }
.vw-list::-webkit-scrollbar,.vw-scroll::-webkit-scrollbar { width:8px }
.vw-list::-webkit-scrollbar-thumb,.vw-scroll::-webkit-scrollbar-thumb { background:var(--fill-2); border-radius:4px }
.vw-search { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:7px; margin:2px 2px 6px;
  padding:7px 9px; border:1px solid var(--hair); border-radius:10px; background:var(--fill); color:var(--mut) }
.vw-search:focus-within { border-color:var(--acc) }
.vw-search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--fg); font:inherit; font-size:12px }
.vw-search input::placeholder { color:var(--mut) }
.vw-search small { min-width:16px; text-align:right; color:var(--mut); font-size:9.5px; font-variant-numeric:tabular-nums }
.vw-srow { display:flex; align-items:center; gap:10px; width:100%; min-height:58px; background:transparent; border:0; border-radius:10px;
  padding:7px 8px; text-align:left; color:var(--fg); font:inherit; cursor:pointer }
.vw-srow:hover,.vw-srow.vw-active { background:var(--fill) }
.vw-srow:focus-visible,.vw-back:focus-visible,.vw-copy:focus-visible { outline:2px solid var(--acc); outline-offset:-2px }
.vw-harness-logo { position:relative; display:inline-grid; place-items:center; width:var(--vw-logo-size); height:var(--vw-logo-size); flex:none;
  border:1px solid var(--bd); border-radius:50%; background:#111; color:#f7f7f5; font-size:calc(var(--vw-logo-size) * .36); font-weight:700; text-transform:uppercase }
.vw-harness-logo svg { width:68%; height:68%; fill:currentColor }
.vw-harness-logo[data-harness="claude-code"],.vw-harness-logo[data-harness="claude"] { color:#d97757; background:#09090b }
.vw-harness-logo[data-harness="codex"] { color:#111; background:#f7f7f5 }
.vw-harness-logo[data-harness="pi"] { color:#111; background:#f0f0ed }
.vw-harness-logo i { position:absolute; right:-2px; bottom:-2px; width:10px; height:10px; border:2px solid var(--bg); border-radius:50%; background:var(--mut) }
.vw-harness-logo[data-activity="working"] i { background:var(--acc); animation:vw-breathe 1.4s ease-in-out infinite }
.vw-harness-logo[data-activity="needs-input"] i { background:var(--ask) }
.vw-harness-logo[data-activity="failed"] i { background:var(--block) }
.vw-harness-logo[data-activity="finished"] i,.vw-harness-logo[data-activity="unseen"] i { background:var(--ok) }
.vw-harness-logo[data-activity="recent"] i { background:var(--mut) }
.vw-scol { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 }
.vw-sline { display:flex; align-items:baseline; justify-content:space-between; gap:8px }
.vw-sname { min-width:0; font-size:12.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-sage { flex:none; display:inline-flex; align-items:center; gap:4px; margin-left:auto; color:var(--mut); font-size:10.5px; font-variant-numeric:tabular-nums }
.vw-follow { flex:none; margin-right:auto; color:var(--acc); font-size:9.5px; text-transform:uppercase; letter-spacing:.04em }
.vw-ssub { display:flex; align-items:baseline; gap:6px; min-width:0; color:var(--mut); font-size:11px }
.vw-sharness { flex:none; text-transform:uppercase; letter-spacing:.04em; font-size:9.5px; background:var(--fill-2); border-radius:5px; padding:1px 5px }
.vw-row-status { flex:none; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.035em; color:var(--mut) }
.vw-row-status[data-activity="working"],.vw-row-status[data-activity="finished"],.vw-row-status[data-activity="unseen"] { color:var(--acc) }
.vw-row-status[data-activity="needs-input"] { color:var(--ask) }.vw-row-status[data-activity="failed"] { color:var(--block) }
.vw-sdetail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-sfail { display:block; color:var(--block); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-srow-opening { background:var(--fill) }

/* Bootstrap has real milestones and continuous motion, so cold-start latency reads as progress. */
.vw-startup { display:grid; grid-template-columns:30px minmax(0,1fr); gap:4px 10px; align-items:center;
  margin:auto 2px; padding:18px 10px; color:var(--mut); text-align:left }
.vw-startup-compact { margin:2px 0 6px; padding:8px; border:1px solid var(--hair); border-radius:9px; background:var(--fill) }
.vw-startup-orbit { grid-row:1 / span 2; position:relative; width:26px; height:26px; border:1px solid var(--bd); border-radius:50% }
.vw-startup-orbit::before { content:""; position:absolute; inset:5px; border-radius:50%; background:var(--fill-2); animation:vw-breathe 1.5s ease-in-out infinite }
.vw-startup-orbit span { position:absolute; inset:-1px; border:2px solid transparent; border-top-color:var(--acc); border-radius:50%; animation:vw-spin 1s linear infinite }
.vw-startup-copy { display:grid; gap:2px; min-width:0 }
.vw-startup-copy strong { color:var(--fg); font-size:12px; font-weight:600 }
.vw-startup-copy > span { font-size:10.5px; line-height:1.35 }
.vw-startup-track { grid-column:2; display:grid; grid-template-columns:repeat(3,minmax(18px,38px)); gap:4px; margin-top:4px }
.vw-startup-track > span { height:2px; overflow:hidden; border-radius:2px; background:var(--fill-2) }
.vw-startup-track .vw-step-done { background:var(--acc) }
.vw-startup-track .vw-step-current::after { content:""; display:block; width:55%; height:100%; background:var(--acc); animation:vw-progress 1s ease-in-out infinite alternate }
@keyframes vw-breathe { 50% { transform:scale(.72); opacity:.5 } }
@keyframes vw-progress { from { transform:translateX(-100%) } to { transform:translateX(180%) } }
@media (prefers-reduced-motion:reduce) {
  .vw-startup-orbit::before,.vw-startup-orbit span,.vw-startup-track .vw-step-current::after,.vw-spinner,.vw-typing-dots i { animation:none }
}

/* transcript */
.vw-scroll { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:12px 16px 18px }
.vw-scroll > div { display:flex; flex-direction:column; gap:10px }
.vw-empty { color:var(--mut); padding:18px 2px; text-align:center }
.vw-cut { color:var(--mut); font-style:italic }
.vw-message { position:relative; margin:2px 0 8px; overflow-wrap:anywhere }
.vw-user { padding:8px 9px; border:1px solid var(--bd); border-radius:9px; background:var(--fill) }
.vw-assistant { padding-bottom:3px }
.vw-pending { opacity:.55 }
.vw-sending { display:block; color:var(--mut); font-size:10px; margin-top:3px }
.vw-message-time { display:inline-block; margin-left:6px; color:var(--mut); font-size:9.5px; opacity:0; transition:opacity 120ms ease }
.vw-message:hover .vw-message-time,.vw-message:focus-within .vw-message-time { opacity:1 }
.vw-message-failed { opacity:1; border-color:var(--block) }
.vw-send-failed { display:flex; align-items:center; gap:6px; margin-top:4px; color:var(--block); font-size:10px }
.vw-send-failed button { border:0; padding:0; background:transparent; color:var(--acc); font:inherit; cursor:pointer }
.vw-latest { position:absolute; right:14px; bottom:112px; z-index:4; padding:5px 9px; border:1px solid var(--bd2);
  border-radius:999px; background:var(--bg2); color:var(--fg); box-shadow:0 2px 8px rgba(0,0,0,.24); font:11px inherit; cursor:pointer }

/* GFM-rich Markdown. markdown-it has raw HTML disabled. */
.vw-markdown { color:var(--fg); font-size:12.5px; line-height:1.55 }
.vw-markdown > :first-child { margin-top:0 }
.vw-markdown > :last-child { margin-bottom:0 }
.vw-markdown p { margin:0 0 8px }
.vw-markdown h1,.vw-markdown h2,.vw-markdown h3,.vw-markdown h4 { margin:13px 0 6px; line-height:1.25; color:var(--fg) }
.vw-markdown h1 { font-size:17px }.vw-markdown h2 { font-size:15px }.vw-markdown h3,.vw-markdown h4 { font-size:13px }
.vw-markdown ul,.vw-markdown ol { margin:5px 0 9px; padding-left:20px }
.vw-markdown li { margin:2px 0 }
.vw-markdown blockquote { margin:8px 0; padding:2px 0 2px 9px; border-left:2px solid var(--bd2); color:var(--mut) }
.vw-markdown a { color:var(--acc); text-decoration:none }.vw-markdown a:hover { text-decoration:underline }
.vw-markdown code { padding:1px 4px; border-radius:4px; background:var(--fill-2); font:.92em ui-monospace,SFMono-Regular,Menlo,monospace }
.vw-markdown pre { margin:8px 0; padding:8px 9px; overflow:auto; border:1px solid var(--hair); border-radius:7px; background:var(--fill) }
.vw-markdown pre code { padding:0; background:transparent; font-size:11px; white-space:pre }
.vw-markdown table { display:block; width:100%; margin:8px 0; overflow-x:auto; border-collapse:collapse; font-size:11px }
.vw-markdown th,.vw-markdown td { padding:4px 5px; border:1px solid var(--bd); text-align:left; vertical-align:top }
.vw-markdown th { background:var(--fill); font-weight:600 }
.vw-markdown hr { border:0; border-top:1px solid var(--hair); margin:12px 0 }
.vw-copy { margin-top:3px; padding:2px 5px; border:0; border-radius:5px; background:transparent; color:var(--mut); font:inherit; font-size:10px; cursor:pointer;
  opacity:0; transition:opacity 120ms ease }
.vw-message:hover .vw-copy,.vw-message:focus-within .vw-copy,.vw-copy:focus-visible { opacity:1 }
.vw-copy:hover { color:var(--fg); background:var(--fill) }

/* Consecutive tools become VGAI-style activity groups with independently expandable rows. */
.vw-tool-group { margin:2px 0 8px; overflow:hidden; border:1px solid var(--bd); border-radius:9px; background:var(--fill) }
.vw-tool-group-head,.vw-tool-row-head { display:flex; align-items:center; gap:6px; min-height:32px; padding:0 8px;
  list-style:none; cursor:pointer; color:var(--mut); font-size:11px }
.vw-tool-group-head::-webkit-details-marker,.vw-tool-row-head::-webkit-details-marker,.vw-reasoning summary::-webkit-details-marker { display:none }
.vw-tool-group-head strong { color:var(--fg); font-weight:600 }
.vw-fold-mark { flex:none; font-size:15px; line-height:10px; transition:transform 120ms ease }
.vw-open,details[open] > summary .vw-fold-mark { transform:rotate(90deg) }
.vw-spacer { flex:1 }
.vw-tool-row { border-top:1px solid var(--hair) }
.vw-tool-glyph { width:15px; color:var(--mut); font:10px ui-monospace,SFMono-Regular,Menlo,monospace; text-align:center }
.vw-tool-name { flex:none; max-width:115px; color:var(--fg); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-tool-target { min-width:0; color:var(--mut); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace }
.vw-tool-state { font-weight:700; color:var(--ok) }
.vw-tool-pending .vw-tool-state { color:var(--ask) }
.vw-tool-error .vw-tool-state,.vw-danger { color:var(--block)!important }
.vw-tool-detail { max-height:240px; overflow:auto; padding:7px 8px 8px; border-top:1px solid var(--hair) }
.vw-tool-code { margin:0; color:var(--mut); font:10.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere }
.vw-tool-code + .vw-tool-code { margin-top:8px }
.vw-tool-code b { color:var(--fg); font:600 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-transform:uppercase; letter-spacing:.05em }

/* reasoning, requests, notices, live status */
.vw-reasoning { margin:2px 0 7px; color:var(--mut); font-size:11.5px }
.vw-reasoning summary { display:flex; align-items:center; gap:5px; cursor:pointer; list-style:none }
.vw-reasoning-body { padding:6px 0 0 13px; white-space:pre-wrap; overflow-wrap:anywhere; font-style:italic }
.vw-notice,.vw-request-done { margin:5px 0; color:var(--mut); font-size:11px; text-align:center }
.vw-request-card { display:grid; gap:5px; margin:4px 0 9px; padding:9px; border:1px solid var(--ask); border-radius:9px }
.vw-request-kind { color:var(--mut); font-size:11px }
.vw-request-card pre { max-height:120px; margin:0; overflow:auto; color:var(--mut); font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap }
.vw-request-actions { display:flex; flex-wrap:wrap; gap:5px }
.vw-request-actions button { padding:4px 7px; border:1px solid var(--bd2); border-radius:6px; background:var(--fill); color:var(--fg); font:inherit; font-size:11px; cursor:pointer }
.vw-request-actions button:disabled { opacity:.45; cursor:default }
.vw-request-actions .vw-request-reject { color:var(--block); border-color:var(--block) }
.vw-typing { align-self:flex-start; display:flex; align-items:center; gap:7px; min-height:28px; padding:5px 8px 5px 6px;
  border:1px solid var(--hair); border-radius:12px; background:var(--fill); color:var(--mut); font-size:10.5px }
.vw-typing-mark { display:grid; place-items:center; width:18px; height:18px; border-radius:50%; background:var(--fill-2); color:var(--acc); font-size:10px }
.vw-typing-dots { display:flex; align-items:center; gap:3px }
.vw-typing-dots i { width:4px; height:4px; border-radius:50%; background:var(--mut); animation:vw-dot 1.1s ease-in-out infinite }
.vw-typing-dots i:nth-child(2) { animation-delay:.14s }.vw-typing-dots i:nth-child(3) { animation-delay:.28s }
@keyframes vw-dot { 0%,60%,100% { transform:translateY(0); opacity:.4 } 30% { transform:translateY(-3px); opacity:1 } }
.vw-spinner { width:8px; height:8px; border:1px solid var(--bd2); border-top-color:var(--acc); border-radius:50%; animation:vw-spin .75s linear infinite }
.vw-spinner-small { display:inline-block; flex:none; width:7px; height:7px }
@keyframes vw-spin { to { transform:rotate(360deg) } }
.vw-operation { display:flex; align-items:center; gap:6px; padding:5px 12px; border-bottom:1px solid var(--hair); color:var(--mut); font-size:10.5px }
.vw-error { margin:6px 12px 0; padding:7px 8px; display:flex; align-items:center; gap:7px; border:1px solid color-mix(in srgb,var(--block) 45%,transparent); border-radius:8px; color:var(--block); font-size:11px }
.vw-error > span { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis }
.vw-error button { border:0; padding:2px 4px; background:transparent; color:inherit; font:inherit; cursor:pointer }

/* composer + compact mirror status */
.vw-composer { border-top:1px solid var(--hair); padding:8px 12px 12px; display:flex; flex-direction:column; gap:6px }
.vw-envelope { overflow:hidden; border:1px solid var(--bd2); border-radius:10px; background:var(--fill) }
.vw-input { display:block; width:100%; min-height:58px; max-height:150px; resize:none; background:transparent; color:var(--fg);
  border:0; padding:8px 9px 4px; font:inherit; font-size:12.5px; outline:none }
.vw-input::placeholder { color:var(--mut) }
.vw-composer-foot { min-height:30px; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:2px 5px 5px 8px }
.vw-agent-id { min-width:0; color:var(--mut); font-size:10px; text-transform:uppercase; letter-spacing:.04em; overflow:hidden; text-overflow:ellipsis }
.vw-actions { display:flex; align-items:center; gap:6px }
.vw-stop,.vw-send { display:inline-flex; align-items:center; justify-content:center; width:27px; height:27px; border-radius:8px;
  font:inherit; font-size:14px; font-weight:600; line-height:1; cursor:pointer }
.vw-stop { background:transparent; color:var(--block); border:1px solid var(--block) }
.vw-send { background:var(--acc); color:var(--on-acc); border:0 }
.vw-stop:disabled { opacity:.4; cursor:default }
.vw-send:disabled { background:var(--fill-2); color:var(--mut); cursor:default }
.vw-queue { display:grid; gap:3px; color:var(--mut); font-size:10.5px }
.vw-queue > div { display:flex; gap:5px; align-items:center }.vw-queue > div span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.vw-queue button { border:0; background:transparent; color:var(--mut); cursor:pointer }
.vw-readonly { display:flex; align-items:center; gap:7px; min-height:34px; padding:6px 8px; border:1px solid var(--hair);
  border-radius:9px; background:var(--fill); color:var(--mut); font-size:10.5px; line-height:1.35 }
.vw-readonly > span:first-child { color:var(--ask); font-size:9px }.vw-readonly strong { color:var(--fg) }
.vw-opening { flex:1; display:grid; place-items:center; align-content:center; gap:7px; padding:24px; color:var(--mut); text-align:center }
.vw-opening .vw-startup-orbit { grid-row:auto }.vw-opening strong { color:var(--fg); font-size:13px }.vw-opening > span:last-child { font-size:11px }
.vw-new-body { min-height:0; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:28px; color:var(--mut); text-align:center }
.vw-new-body strong { color:var(--fg); font-size:14px }.vw-new-body > span:last-child { max-width:29ch; font-size:11px }
.vw-new-mark { display:grid; place-items:center; width:38px; height:38px; margin-bottom:5px; border-radius:50%; background:var(--fill); color:var(--acc); font-size:17px }
.vw-new-picker { display:flex; align-items:center; gap:8px; padding:0 2px; color:var(--mut); font-size:10.5px }
.vw-new-picker label { flex:1 }.vw-new-picker select { max-width:180px; padding:4px 7px; border:1px solid var(--bd); border-radius:7px; background:var(--fill); color:var(--fg); font:inherit }
`;
