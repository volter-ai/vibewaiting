import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type GrokPdfInput = Record<string, unknown>;

export interface GrokPdfReadResult {
  output: string;
  images?: string[];
}

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export async function readGrokPdf(path: string, bytes: Uint8Array, input: GrokPdfInput): Promise<GrokPdfReadResult> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { output: `PDF file is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, exceeds the 50 MB limit.` };
  }
  const format = typeof input.format === "string" ? input.format : "image";
  if (format !== "image" && format !== "text") {
    return { output: `Invalid format '${format}'. Supported values: 'image' (default), 'text'.` };
  }
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = typeof window === "undefined"
      ? new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href
      : pdfWorkerUrl;
    const documentHandle = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
    if (documentHandle.numPages === 0) return { output: "PDF has no pages" };
    let pageIndices: number[];
    try {
      pageIndices = parseGrokPdfPages(typeof input.pages === "string" ? input.pages : undefined, documentHandle.numPages);
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
    if (format === "text") {
      const pageText: string[] = [];
      for (const index of pageIndices) {
        const page = await documentHandle.getPage(index + 1);
        const content = await page.getTextContent();
        pageText.push(`--- Page ${index + 1} ---\n${content.items.map((item) => "str" in item ? item.str : "").join(" ")}`);
      }
      return { output: numberEveryDocumentLine(pageText.join("\n")) };
    }
    if (typeof document === "undefined") throw new Error("PDF page rendering requires a browser canvas");
    const images: string[] = [];
    for (const index of pageIndices) {
      const page = await documentHandle.getPage(index + 1);
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PDF canvas context is unavailable");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF page encoding failed")), "image/jpeg", 0.85));
      images.push(`data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`);
    }
    return { output: `Read PDF file: ${path} (${images.length} pages rendered, ${documentHandle.numPages} total)`, images };
  } catch (error) {
    return { output: `Failed to open PDF: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Source-ported Grok Build PDF page-range parser. */
export function parseGrokPdfPages(spec: string | undefined, pageCount: number): number[] {
  if (spec === undefined) {
    if (pageCount > 10) {
      throw new Error(`PDF has ${pageCount} pages which exceeds the 10 page auto-read limit. Use the \`pages\` parameter to specify which pages to read (e.g. pages="1-5"). Maximum 20 pages per call.`);
    }
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  const pages: number[] = [];
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const dash = part.indexOf("-");
    if (dash >= 0) {
      const start = pdfPageNumber(part.slice(0, dash).trim());
      const rawEnd = part.slice(dash + 1).trim();
      const end = rawEnd ? pdfPageNumber(rawEnd) : pageCount;
      if (start < 1 || start > pageCount) throw new Error(`page ${start} out of range (document has ${pageCount} pages)`);
      if (start > end) throw new Error(`invalid page range: ${start}-${end} (start must be ≤ end)`);
      for (let page = start; page <= Math.min(end, pageCount); page += 1) pages.push(page - 1);
    } else {
      const page = pdfPageNumber(part);
      if (page < 1 || page > pageCount) throw new Error(`page ${page} out of range (document has ${pageCount} pages)`);
      pages.push(page - 1);
    }
  }
  const unique = [...new Set(pages)].sort((left, right) => left - right);
  if (unique.length > 20) throw new Error(`requested ${unique.length} pages, maximum is 20 per call`);
  if (unique.length === 0) throw new Error("no pages specified");
  return unique;
}

export function isGrokPdf(path: string, bytes: Uint8Array): boolean {
  return /\.pdf$/iu.test(path) || decodeAscii(bytes.slice(0, 5)) === "%PDF-";
}

function pdfPageNumber(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`invalid page number: '${value}'`);
  const page = Number(value);
  if (!Number.isSafeInteger(page)) throw new Error(`invalid page number: '${value}'`);
  return page;
}

function numberEveryDocumentLine(content: string): string {
  return content.split("\n").map((line, index) => `${index + 1}→${line}`).join("\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodeAscii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
