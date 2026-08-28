export interface BrowserCapabilityScope {
  AbortSignal?: typeof AbortSignal;
  Blob?: typeof Blob;
  DecompressionStream?: typeof DecompressionStream;
  MessageChannel?: typeof MessageChannel;
  ReadableStream?: typeof ReadableStream;
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
  WebAssembly?: typeof WebAssembly;
  Worker?: typeof Worker;
  crypto?: Crypto;
  fetch?: typeof fetch;
  indexedDB?: IDBFactory;
  isSecureContext?: boolean;
  navigator?: Navigator;
  structuredClone?: typeof structuredClone;
}

/** APIs required by the filesystem, stream transport, archive, and sandbox paths. */
export function missingBrowserAgentCapabilities(scope: BrowserCapabilityScope): string[] {
  const missing: string[] = [];
  if (scope.isSecureContext !== true) missing.push("secure context (HTTPS)");
  if (!scope.navigator?.serviceWorker) missing.push("service workers");
  if (!scope.indexedDB) missing.push("IndexedDB");
  if (!scope.crypto?.subtle || typeof scope.crypto.randomUUID !== "function") missing.push("Web Crypto");
  if (!scope.WebAssembly) missing.push("WebAssembly");
  if (!scope.Worker) missing.push("Web Workers");
  if (!scope.MessageChannel) missing.push("MessageChannel");
  if (!scope.ReadableStream || !scope.Blob?.prototype.stream) missing.push("web streams");
  if (!scope.DecompressionStream) missing.push("DecompressionStream");
  if (!scope.TextEncoder || !scope.TextDecoder) missing.push("text encoding");
  if (!scope.fetch) missing.push("Fetch");
  if (!scope.structuredClone) missing.push("structuredClone");
  if (typeof scope.AbortSignal?.any !== "function" || typeof scope.AbortSignal?.timeout !== "function") {
    missing.push("modern AbortSignal");
  }
  return missing;
}
