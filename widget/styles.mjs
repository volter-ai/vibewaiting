// The panel's own CSS, concatenated AFTER `lucarne/widget`'s `SHELL_CSS` at build time (see
// `build.mjs`). Plain JS so the build script can import it without a TypeScript step.
//
// Every colour is one of the shell's own custom properties — the shell flips them for the light
// skin when the host probes a light page, so the panel follows the page's theme for free. Adding a
// literal colour here is what would break that.
export const PANEL_CSS = `
.vw-chat { display: flex; flex-direction: column; max-height: 420px }

/* session list (the messenger's root view) */
.vw-list { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain;
  max-height: 380px; min-height: 90px; padding: 2px 6px 8px }
.vw-list::-webkit-scrollbar { width: 8px }
.vw-list::-webkit-scrollbar-thumb { background: var(--fill-2); border-radius: 4px }

.vw-srow { display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
  background: transparent; border: 0; border-radius: 9px; padding: 8px 8px; text-align: left;
  color: var(--fg); font: inherit; cursor: pointer }
.vw-srow:hover { background: var(--fill) }
.vw-srow.vw-active { background: var(--fill) }
/* the dot is LIVENESS (someone is working in this session now), never "the panel is following it" */
.vw-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--fill-2); border: 1px solid var(--bd) }
.vw-dot.vw-live { background: var(--ok); border-color: var(--ok) }
.vw-scol { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 }
.vw-sline { display: flex; align-items: baseline; justify-content: space-between; gap: 8px }
.vw-sname { min-width: 0; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.vw-sage { flex: none; margin-left: auto; color: var(--mut); font-size: 10.5px; font-variant-numeric: tabular-nums }
/* which session the panel is on — said in words next to the name, not by the liveness dot */
.vw-follow { flex: none; margin-right: auto; color: var(--acc); font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em }
.vw-ssub { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--mut); font-size: 11px }
.vw-sharness { flex: none; text-transform: uppercase; letter-spacing: .04em; font-size: 9.5px;
  background: var(--fill-2); border-radius: 5px; padding: 1px 5px }
.vw-sdetail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
/* why the tap did not open a chat — one line, in place of the subtitle, gone on its own */
.vw-sfail { display: block; color: var(--block); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }

/* chat header */
.vw-head { display: flex; align-items: center; gap: 7px; padding: 4px 10px 8px }
.vw-back { flex: none; background: var(--fill); color: var(--fg); border: 1px solid var(--bd); border-radius: 7px;
  width: 22px; height: 22px; line-height: 1; font: inherit; font-size: 15px; cursor: pointer; padding: 0 }
.vw-back:hover { background: var(--fill-2); border-color: var(--acc) }
.vw-hname { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.vw-hsub { flex: none; color: var(--mut); font-size: 10px; text-transform: uppercase; letter-spacing: .04em }
.vw-ro { flex: none; margin-left: auto; color: var(--ask); font-size: 10px; text-transform: uppercase; letter-spacing: .04em }

/* transcript */
.vw-scroll { overflow-y: auto; overscroll-behavior: contain; padding: 2px 12px 8px; display: flex; flex-direction: column; gap: 10px; min-height: 90px; max-height: 300px }
.vw-scroll::-webkit-scrollbar { width: 8px }
.vw-scroll::-webkit-scrollbar-thumb { background: var(--fill-2); border-radius: 4px }
.vw-empty { color: var(--mut); padding: 18px 2px; text-align: center }

.vw-row { display: flex; flex-direction: column; gap: 3px }
.vw-meta { display: flex; align-items: baseline; gap: 6px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--mut) }
.vw-role { font-weight: 600 }
.vw-time { font-variant-numeric: tabular-nums; opacity: .75 }
.vw-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.5 }
.vw-cut { color: var(--mut); font-style: italic }

.vw-user .vw-role { color: var(--acc) }
.vw-user .vw-text { background: var(--fill); border-left: 2px solid var(--acc); border-radius: 0 8px 8px 0; padding: 5px 8px }
.vw-assistant .vw-role { color: var(--ok) }
.vw-fold { border: 1px solid var(--hair); border-radius: 8px; background: var(--fill); overflow: hidden }
.vw-fold-head { display: flex; align-items: center; gap: 6px; padding: 5px 7px; color: var(--mut);
  font-size: 10px; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; list-style: none }
.vw-fold-head::-webkit-details-marker { display: none }
.vw-fold-mark { flex: none; font-size: 15px; line-height: 10px; transition: transform 120ms ease }
.vw-fold[open] .vw-fold-mark { transform: rotate(90deg) }
.vw-tool-name { min-width: 0; color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; font-weight: 600; text-transform: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.vw-tool-status { margin-left: auto; font-size: 9px }
.vw-tool-pending .vw-tool-status { color: var(--ask) }
.vw-tool-error { border-color: var(--block) }
.vw-tool-error .vw-tool-status { color: var(--block) }
.vw-tool-body { margin: 0; border-top: 1px solid var(--hair); padding: 7px 8px; color: var(--mut);
  font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word;
  max-height: 9em; overflow: auto }
.vw-reasoning .vw-role { color: var(--mut) }
.vw-thinking-live { color: var(--ask); font-size: 9px }
.vw-reasoning-body { border-top: 1px solid var(--hair); padding: 6px 8px; color: var(--mut);
  font-size: 12px; line-height: 1.45; font-style: italic; white-space: pre-wrap; word-break: break-word }
.vw-request .vw-role { color: var(--ask) }
.vw-notice .vw-text { color: var(--ask) }
.vw-pending { opacity: .55 }

.vw-error { margin: 0 12px 6px; padding: 6px 8px; border-radius: 8px; background: var(--fill); color: var(--block); font-size: 11.5px }

/* composer */
.vw-composer { border-top: 1px solid var(--hair); padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 6px }
.vw-input { width: 100%; resize: none; box-sizing: border-box; background: var(--fill); color: var(--fg);
  border: 1px solid var(--bd); border-radius: 9px; padding: 7px 9px; font: inherit; font-size: 12.5px; outline: none }
.vw-input:focus { border-color: var(--acc); background: var(--fill-2) }
.vw-input::placeholder { color: var(--mut) }
.vw-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px }
.vw-hint { color: var(--mut); font-size: 10.5px }
.vw-actions { display: flex; align-items: center; gap: 6px }
.vw-stop { background: transparent; color: var(--block); border: 1px solid var(--block); border-radius: 8px;
  padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer }
.vw-send { background: var(--acc); color: var(--on-acc); border: 0; border-radius: 8px; padding: 5px 12px;
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer }
.vw-send:disabled { background: var(--fill-2); color: var(--mut); cursor: default }
`;
