// The panel's own CSS, concatenated AFTER `lucarne/widget`'s `SHELL_CSS` at build time (see
// `build.mjs`). Plain JS so the build script can import it without a TypeScript step.
//
// Every colour is one of the shell's own custom properties — the shell flips them for the light
// skin when the host probes a light page, so the panel follows the page's theme for free. Adding a
// literal colour here is what would break that.
export const PANEL_CSS = `
.vw { display: flex; flex-direction: column; max-height: 420px }

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
.vw-tool .vw-text, .vw-reasoning .vw-text { color: var(--mut); font-size: 12px }
.vw-tool .vw-text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; max-height: 8.5em; overflow: hidden }
.vw-reasoning .vw-text { font-style: italic }
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
.vw-send { background: var(--acc); color: var(--on-acc); border: 0; border-radius: 8px; padding: 5px 12px;
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer }
.vw-send:disabled { background: var(--fill-2); color: var(--mut); cursor: default }
`;
