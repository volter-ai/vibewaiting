/** Searchable fields copied into Grok Build's per-request BM25 corpus. */
export interface McpSearchDocument {
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: string[];
}

export type McpRankedDocument<T extends McpSearchDocument> = T & { score: number };

const K1 = Math.fround(1.2);
const B = Math.fround(0.75);

// bm25 2.3.2 uses stop-words 0.9's NLTK English corpus before stemming.
const ENGLISH_STOP_WORDS = new Set(`i me my myself we our ours ourselves you you're you've you'll you'd your yours yourself yourselves he him his himself she she's her hers herself it it's its itself they them their theirs themselves what which who whom this that that'll these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don don't should should've now d ll m o re ve y ain aren aren't couldn couldn't didn didn't doesn doesn't hadn hadn't hasn hasn't haven haven't isn isn't ma mightn mightn't mustn mustn't needn needn't shan shan't shouldn shouldn't wasn wasn't weren weren't won won't wouldn wouldn't`.split(/\s+/u));

/** Source-port of tool_index.rs composition and bm25 2.3.2 scoring. */
export function searchMcpDocuments<T extends McpSearchDocument>(tools: readonly T[], query: string, limit: number): Array<McpRankedDocument<T>> {
  if (tools.length === 0 || limit === 0) return [];
  const queryLower = query.trim().toLowerCase();
  const exact = tools.find((tool) => tool.qualifiedName.toLowerCase() === queryLower || tool.toolName.toLowerCase() === queryLower);
  if (exact) return [{ ...exact, score: 1 }];

  const documents = tools.map((tool) => tokenizeEnglish(toolDocument(tool)));
  const queryTerms = tokenizeEnglish(normalizeQuery(query));
  if (queryTerms.length === 0) return [];
  const averageLength = Math.fround(documents.reduce((sum, document) => sum + document.length, 0) / documents.length) || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    documentFrequency.set(term, documents.reduce((count, document) => count + (document.includes(term) ? 1 : 0), 0));
  }
  return tools.map((tool, index) => ({
    ...tool,
    score: bm25Score(documents[index] ?? [], queryTerms, documentFrequency, documents.length, averageLength),
  })).filter((tool) => tool.score > 0)
    // Native equal-score order originates in a HashSet and is deliberately not a contract.
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function toolDocument(tool: McpSearchDocument): string {
  const components = [tool.serverName, tool.toolName].flatMap(splitIdentifier)
    .concat(tool.parameters.flatMap(splitIdentifier));
  return `${tool.serverName} ${tool.toolName} ${tool.description} ${tool.parameters.join(" ")} ${components.join(" ")}`;
}

function bm25Score(document: string[], query: string[], dfs: Map<string, number>, count: number, averageLength: number): number {
  const frequency = new Map<string, number>();
  for (const term of document) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  let score = Math.fround(0);
  // bm25's query embedding preserves duplicate indices; each occurrence contributes.
  for (const term of query) {
    const tf = Math.fround(frequency.get(term) ?? 0);
    if (tf === 0) continue;
    const df = Math.fround(dfs.get(term) ?? 0);
    const numerator = Math.fround(Math.fround(count) - df + Math.fround(0.5));
    const denominator = Math.fround(df + Math.fround(0.5));
    const idf = Math.fround(Math.log(Math.fround(1 + Math.fround(numerator / denominator))));
    const lengthRatio = Math.fround(Math.fround(document.length) / averageLength);
    const normalization = Math.fround(Math.fround(1 - B) + Math.fround(B * lengthRatio));
    const saturation = Math.fround(Math.fround(tf * Math.fround(K1 + 1)) / Math.fround(tf + Math.fround(K1 * normalization)));
    score = Math.fround(score + Math.fround(idf * saturation));
  }
  return score;
}

function normalizeQuery(query: string): string {
  const needsSplit = query.includes("__") || query.includes("_") || query.includes("-") || /[a-z][A-Z]/u.test(query);
  if (!needsSplit) return query;
  const extra = query.split(/\s+/u).flatMap(splitIdentifier);
  return extra.length ? `${query} ${extra.join(" ")}` : query;
}

function splitIdentifier(value: string): string[] {
  return value.split(/__|_|-/u).flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/u)).filter(Boolean);
}

function tokenizeEnglish(value: string): string[] {
  // deunicode's full transliteration table is larger than this browser module; NFKD is exact
  // for ordinary Latin accents and the remaining non-Latin corpus gap stays recorded in parity.
  const normalized = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return (normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .filter((token) => !ENGLISH_STOP_WORDS.has(token))
    .map(stemEnglish);
}

/** Conservative Porter/Snowball-compatible suffixes used by tool-search vocabulary. */
function stemEnglish(word: string): string {
  if (word.length <= 2) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}i`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s") && /[aeiouy]/u.test(word.slice(0, -2))) word = word.slice(0, -1);
  if (word.endsWith("eedly") && word.length > 7) word = `${word.slice(0, -5)}ee`;
  else if (word.endsWith("eed") && word.length > 5) word = `${word.slice(0, -3)}ee`;
  else {
    const suffix = word.endsWith("ingly") ? "ingly" : word.endsWith("edly") ? "edly" : word.endsWith("ing") ? "ing" : word.endsWith("ed") ? "ed" : "";
    if (suffix && /[aeiouy]/u.test(word.slice(0, -suffix.length))) {
      word = word.slice(0, -suffix.length);
      if (/(at|bl|iz)$/u.test(word)) word += "e";
      else if (/([^aeiouylsz])\1$/u.test(word)) word = word.slice(0, -1);
    }
  }
  const replacements: Array<[RegExp, string]> = [
    [/ational$/u, "ate"], [/tional$/u, "tion"], [/enci$/u, "ence"], [/anci$/u, "ance"],
    [/izer$/u, "ize"], [/fulness$/u, "ful"], [/ousness$/u, "ous"], [/iveness$/u, "ive"],
    [/mentli$/u, "ment"], [/biliti$/u, "ble"], [/alli$/u, "al"], [/entli$/u, "ent"],
  ];
  for (const [suffix, replacement] of replacements) {
    if (suffix.test(word) && word.length - word.match(suffix)![0].length >= 2) return word.replace(suffix, replacement);
  }
  if (word.endsWith("e") && word.length > 4) return word.slice(0, -1);
  return word;
}
