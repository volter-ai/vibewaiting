/* tslint:disable */
/* eslint-disable */
export class CodexBrowserCore {
  free(): void;
  /**
   * Adds the user input and produces Codex's Responses request projection.
   */
  buildRequest(prompt: string, model: string, instructions: string, tools: any, reasoning_effort: string): any;
  static fromSnapshot(snapshot: any): CodexBrowserCore;
  static clientVersion(): string;
  /**
   * Replays the model-visible output families exactly into the next request.
   */
  acceptResponse(response: any): any;
  static sourceRevision(): string;
  appendToolOutput(call_id: string, output: string, is_error: boolean): void;
  /**
   * Rebuilds the same request without adding another user message after tool execution.
   */
  buildContinuationRequest(model: string, instructions: string, tools: any, reasoning_effort: string): any;
  constructor(session_id: string, thread_id: string);
  snapshot(): any;
  readonly sessionId: string;
  readonly turn: number;
  readonly threadId: string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_codexbrowsercore_free: (a: number, b: number) => void;
  readonly codexbrowsercore_acceptResponse: (a: number, b: number, c: number) => void;
  readonly codexbrowsercore_appendToolOutput: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly codexbrowsercore_buildContinuationRequest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly codexbrowsercore_buildRequest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
  readonly codexbrowsercore_clientVersion: (a: number) => void;
  readonly codexbrowsercore_fromSnapshot: (a: number, b: number) => void;
  readonly codexbrowsercore_new: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly codexbrowsercore_sessionId: (a: number, b: number) => void;
  readonly codexbrowsercore_snapshot: (a: number, b: number) => void;
  readonly codexbrowsercore_sourceRevision: (a: number) => void;
  readonly codexbrowsercore_threadId: (a: number, b: number) => void;
  readonly codexbrowsercore_turn: (a: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number) => number;
  readonly __wbindgen_export_1: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: (a: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
