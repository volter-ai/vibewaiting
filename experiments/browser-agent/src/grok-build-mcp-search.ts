import { searchGrokBuildToolsExact } from "./grok-build-rhai-wasm.js";

/** Searchable fields copied into Grok Build's per-request BM25 corpus. */
export interface McpSearchDocument {
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: string[];
}

export type McpRankedDocument<T extends McpSearchDocument> = T & { score: number };

/** Source-port of tool_index.rs, backed by Grok Build's exact bm25 2.3.2 crate. */
export async function searchMcpDocuments<T extends McpSearchDocument>(
  tools: readonly T[],
  query: string,
  limit: number,
): Promise<Array<McpRankedDocument<T>>> {
  const ranked = await searchGrokBuildToolsExact(tools, query, limit);
  return ranked.flatMap(({ index, score }) => {
    const tool = tools[index];
    return tool ? [{ ...tool, score }] : [];
  });
}
