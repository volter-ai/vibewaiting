// App-specific layout and presentation. All color comes from Lucarne's adaptive shell tokens, so
// this keeps VGAI's information architecture without inheriting VGAI's editor backdrop/theme.
export const PANEL_CSS = `
.vw-chat { display:flex; flex-direction:column; height:min(76vh,720px); min-height:360px }

/* session list */
.vw-list { display:flex; flex-direction:column; overflow-y:auto; overscroll-behavior:contain;
  max-height:520px; min-height:90px; padding:2px 6px 8px }
.vw-list::-webkit-scrollbar,.vw-scroll::-webkit-scrollbar { width:8px }
.vw-list::-webkit-scrollbar-thumb,.vw-scroll::-webkit-scrollbar-thumb { background:var(--fill-2); border-radius:4px }
.vw-srow { display:flex; align-items:center; gap:9px; width:100%; background:transparent; border:0; border-radius:9px;
  padding:8px; text-align:left; color:var(--fg); font:inherit; cursor:pointer }
.vw-srow:hover,.vw-srow.vw-active { background:var(--fill) }
.vw-dot { flex:none; width:7px; height:7px; border-radius:50%; background:var(--fill-2); border:1px solid var(--bd) }
.vw-dot.vw-live { background:var(--ok); border-color:var(--ok) }
.vw-scol { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 }
.vw-sline { display:flex; align-items:baseline; justify-content:space-between; gap:8px }
.vw-sname { min-width:0; font-size:12.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-sage { flex:none; margin-left:auto; color:var(--mut); font-size:10.5px; font-variant-numeric:tabular-nums }
.vw-follow { flex:none; margin-right:auto; color:var(--acc); font-size:9.5px; text-transform:uppercase; letter-spacing:.04em }
.vw-ssub { display:flex; align-items:baseline; gap:6px; min-width:0; color:var(--mut); font-size:11px }
.vw-sharness { flex:none; text-transform:uppercase; letter-spacing:.04em; font-size:9.5px; background:var(--fill-2); border-radius:5px; padding:1px 5px }
.vw-sdetail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-sfail { display:block; color:var(--block); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }

/* chat header + normalized work plan */
.vw-head { display:flex; align-items:center; gap:7px; padding:4px 10px 8px }
.vw-back { flex:none; background:var(--fill); color:var(--fg); border:1px solid var(--bd); border-radius:7px;
  width:22px; height:22px; line-height:1; font:inherit; font-size:15px; cursor:pointer; padding:0 }
.vw-back:hover { background:var(--fill-2); border-color:var(--acc) }
.vw-hname { font-size:12.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.vw-hsub { flex:none; color:var(--mut); font-size:10px; text-transform:uppercase; letter-spacing:.04em }
.vw-ro { flex:none; margin-left:auto; color:var(--ask); font-size:10px; text-transform:uppercase; letter-spacing:.04em }
.vw-work-plan { display:grid; gap:6px; padding:7px 12px 8px; border-bottom:1px solid var(--hair); font-size:11px }
.vw-working-on { display:flex; gap:6px; min-width:0; color:var(--mut) }
.vw-working-on strong { color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.vw-plan-items { display:grid; gap:2px }
.vw-plan-item { display:grid; grid-template-columns:14px minmax(0,1fr); gap:5px; color:var(--mut) }
.vw-plan-in_progress { color:var(--acc) }
.vw-plan-completed span:last-child { text-decoration:line-through; opacity:.72 }

/* transcript */
.vw-scroll { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:4px 12px 14px;
  display:flex; flex-direction:column; gap:10px }
.vw-empty { color:var(--mut); padding:18px 2px; text-align:center }
.vw-cut { color:var(--mut); font-style:italic }
.vw-message { position:relative; margin:2px 0 8px; overflow-wrap:anywhere }
.vw-user { padding:8px 9px; border:1px solid var(--bd); border-radius:9px; background:var(--fill) }
.vw-assistant { padding-bottom:3px }
.vw-pending { opacity:.55 }
.vw-sending { display:block; color:var(--mut); font-size:10px; margin-top:3px }

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
.vw-copy { margin-top:3px; padding:2px 5px; border:0; border-radius:5px; background:transparent; color:var(--mut); font:inherit; font-size:10px; cursor:pointer }
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
.vw-request-actions button,.vw-mirror-card button { padding:4px 7px; border:1px solid var(--bd2); border-radius:6px; background:var(--fill); color:var(--fg); font:inherit; font-size:11px; cursor:pointer }
.vw-request-actions button:disabled { opacity:.45; cursor:default }
.vw-request-actions .vw-request-reject { color:var(--block); border-color:var(--block) }
.vw-working { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:11px }
.vw-spinner { width:8px; height:8px; border:1px solid var(--bd2); border-top-color:var(--acc); border-radius:50%; animation:vw-spin .75s linear infinite }
@keyframes vw-spin { to { transform:rotate(360deg) } }
.vw-error { margin:0 12px 6px; padding:6px 8px; border-radius:8px; background:var(--fill); color:var(--block); font-size:11.5px }

/* composer + mirror explanation */
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
.vw-mirror-card { display:grid; gap:7px; padding:9px; border:1px solid var(--bd); border-radius:9px; color:var(--mut); font-size:11.5px; line-height:1.45 }
.vw-mirror-card strong { color:var(--fg) }.vw-mirror-card button { justify-self:start }
`;
