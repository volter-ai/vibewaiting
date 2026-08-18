import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionArtifact } from "@volter-ai-dev/supercode-harness-sdk";
import type { ExportReceipt } from "./projection.js";

/** Artifact paths come from a harness. Keep their hierarchy, but never let it escape our bundle. */
export function safeArtifactPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
  return join(...segments);
}

/** Materialize one immutable export bundle inside the caller-approved workspace export root. */
export async function writeSessionArtifact(artifact: SessionArtifact, root: string): Promise<ExportReceipt> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const bundle = await mkdtemp(join(root, `${artifact.target_harness}-`));
  const files = artifact.files.length
    ? artifact.files.map((file) => ({ path: safeArtifactPath(file.path), content: file.content }))
    : [{ path: basename(artifact.suggested_filename) || `${artifact.target_harness}-session.jsonl`, content: artifact.content }];
  for (const file of files) {
    const output = join(bundle, file.path);
    await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
    await writeFile(output, file.content, { encoding: "utf8", mode: 0o600 });
  }
  return {
    targetHarness: artifact.target_harness,
    fidelity: artifact.fidelity,
    path: bundle,
    files: files.length,
    residueCount: artifact.residue.length,
  };
}
