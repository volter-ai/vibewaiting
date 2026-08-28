// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildWorkflowFileSystem } from "./grok-build-workflow-registry.js";
import type { GrokBuildWorkflowJournalEntry, GrokBuildWorkflowJournalStorage } from "./grok-build-workflow-engine.js";

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 10_000;

interface PersistedJournalEntry {
  seq: number;
  kind: string;
  req_hash: string;
  result: unknown;
  at_ms: number;
}

function validRunId(runId: string): boolean { return /^wf_[a-zA-Z0-9_-]+$/u.test(runId); }

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

export class GrokBuildVfsWorkflowJournalStorage implements GrokBuildWorkflowJournalStorage {
  constructor(private readonly vfs: GrokBuildWorkflowFileSystem, private readonly runRoot = "/.grok/workflow-runs") {}

  load(executionId: string): GrokBuildWorkflowJournalEntry[] {
    const path = this.path(executionId);
    if (!this.vfs.existsSync(path)) return [];
    if (!this.vfs.statSync(path).isFile()) throw new Error(`journal restore rejected: journal is not a regular file: ${path}`);
    const bytes = this.vfs.readFileSync(path);
    if (bytes.byteLength > MAX_JOURNAL_BYTES) throw new Error(`journal restore rejected: journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = source.split("\n");
    const entries: GrokBuildWorkflowJournalEntry[] = [];
    let repairedSource: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) {
        if (index === lines.length - 1 && line && !source.endsWith("\n")) repairedSource = source.slice(0, Math.max(0, source.lastIndexOf("\n") + 1));
        continue;
      }
      let parsed: PersistedJournalEntry;
      try { parsed = JSON.parse(line) as PersistedJournalEntry; }
      catch (error) {
        if (index === lines.length - 1 && !source.endsWith("\n")) {
          repairedSource = source.slice(0, Math.max(0, source.lastIndexOf("\n") + 1));
          break;
        }
        throw new Error(`journal parse at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (entries.length >= MAX_JOURNAL_ENTRIES) throw new Error(`journal restore rejected: too many journal entries (limit ${MAX_JOURNAL_ENTRIES})`);
      if (parsed.seq !== entries.length) throw new Error(`journal is not dense at entry ${entries.length}: expected sequence ${entries.length}, found ${parsed.seq}`);
      if (typeof parsed.kind !== "string" || typeof parsed.req_hash !== "string") throw new Error(`journal parse at line ${index + 1}: invalid entry`);
      entries.push({ seq: parsed.seq, kind: parsed.kind, requestHash: parsed.req_hash, value: parsed.result, atMs: parsed.at_ms });
    }
    if (repairedSource !== undefined) this.vfs.writeFileSync(path, repairedSource);
    else if (source && !source.endsWith("\n")) this.vfs.writeFileSync(path, `${source}\n`);
    return entries;
  }

  save(executionId: string, journal: readonly GrokBuildWorkflowJournalEntry[]): void {
    if (journal.length > MAX_JOURNAL_ENTRIES) throw new Error(`journal full: maximum ${MAX_JOURNAL_ENTRIES} entries`);
    const source = journal.map((entry): string => JSON.stringify({
      seq: entry.seq,
      kind: entry.kind,
      req_hash: entry.requestHash,
      result: entry.value,
      at_ms: entry.atMs ?? Date.now(),
    } satisfies PersistedJournalEntry)).join("\n") + (journal.length ? "\n" : "");
    if (utf8Length(source) > MAX_JOURNAL_BYTES) throw new Error(`journal full: appending would exceed the ${MAX_JOURNAL_BYTES}-byte cap`);
    const path = this.path(executionId);
    this.vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    this.vfs.writeFileSync(path, source);
  }

  pruneTrailingHostError(executionId: string, failureDetail: string): void {
    const entries = this.load(executionId);
    const value = entries.at(-1)?.value;
    const message = value && typeof value === "object"
      ? (value as { __xai_workflow_host_error?: unknown }).__xai_workflow_host_error
      : undefined;
    if (typeof message !== "string" || !message || !failureDetail.includes(message)) return;
    entries.pop();
    this.save(executionId, entries);
  }

  private path(executionId: string): string {
    if (!validRunId(executionId)) throw new Error(`invalid workflow run id: ${executionId}`);
    return `${this.runRoot.replace(/\/$/u, "")}/${executionId}/journal.jsonl`;
  }
}
