export type WebReferenceTarget =
  | { provider: "web"; kind: "page" }
  | {
      provider: "hacker-news";
      kind: "item";
      itemId: string;
    }
  | {
      provider: "github";
      kind: "repository";
      owner: string;
      repository: string;
    }
  | {
      provider: "github";
      kind: "issue" | "pull-request" | "discussion";
      owner: string;
      repository: string;
      number: string;
    }
  | {
      provider: "github";
      kind: "commit" | "actions-run";
      owner: string;
      repository: string;
      revision: string;
    }
  | {
      provider: "github";
      kind: "file";
      owner: string;
      repository: string;
      ref: string;
      path: string;
      lines?: { start: number; end: number };
    };

export interface WebReference {
  version: 1;
  url: string;
  target: WebReferenceTarget;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function githubTarget(url: URL): WebReferenceTarget | null {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const segments = url.pathname.split("/").filter(Boolean).map(decoded);
  const [owner, repository, family, identity, ...rest] = segments;
  if (!owner || !repository) return null;
  const base = { provider: "github" as const, owner, repository };
  if (!family) return { ...base, kind: "repository" };
  if (
    (family === "issues" || family === "pull" || family === "discussions") &&
    /^\d+$/.test(identity ?? "")
  ) {
    return {
      ...base,
      kind:
        family === "pull"
          ? "pull-request"
          : family === "discussions"
            ? "discussion"
            : "issue",
      number: identity!,
    };
  }
  if (family === "commit" && identity)
    return { ...base, kind: "commit", revision: identity };
  if (family === "actions" && identity === "runs" && rest[0])
    return { ...base, kind: "actions-run", revision: rest[0] };
  if (family !== "blob" || !identity || !rest.length) return null;
  const match = /^#?L(\d+)(?:-L?(\d+))?$/.exec(url.hash);
  const start = match ? Number(match[1]) : null;
  const end = match ? Number(match[2] ?? match[1]) : null;
  return {
    ...base,
    kind: "file",
    ref: identity,
    path: rest.join("/"),
    ...(start !== null && end !== null
      ? { lines: { start: Math.min(start, end), end: Math.max(start, end) } }
      : {}),
  };
}

function hackerNewsTarget(url: URL): WebReferenceTarget | null {
  if (url.hostname.toLowerCase() !== "news.ycombinator.com") return null;
  const itemId = url.pathname === "/item" ? url.searchParams.get("id") : null;
  return itemId && /^\d+$/.test(itemId)
    ? { provider: "hacker-news", kind: "item", itemId }
    : null;
}

export function classifyWebReference(value: string): WebReference | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const target = githubTarget(url) ?? hackerNewsTarget(url) ?? {
      provider: "web" as const,
      kind: "page" as const,
    };
    return { version: 1, url: url.toString(), target };
  } catch {
    return null;
  }
}

export function webReferenceLabel(
  reference: WebReference,
  fallback: string,
): string {
  const target = reference.target;
  if (target.provider === "hacker-news") return `Hacker News item ${target.itemId}`;
  if (target.provider !== "github") return fallback || "Web page";
  const repository = `${target.owner}/${target.repository}`;
  switch (target.kind) {
    case "repository":
      return `GitHub · ${repository}`;
    case "issue":
      return `GitHub issue · ${repository} #${target.number}`;
    case "pull-request":
      return `GitHub pull request · ${repository} #${target.number}`;
    case "discussion":
      return `GitHub discussion · ${repository} #${target.number}`;
    case "commit":
      return `GitHub commit · ${repository} ${target.revision.slice(0, 8)}`;
    case "actions-run":
      return `GitHub Actions run · ${repository} ${target.revision}`;
    case "file": {
      const lines = target.lines
        ? `:${target.lines.start}${target.lines.end === target.lines.start ? "" : `-${target.lines.end}`}`
        : "";
      return `GitHub file · ${repository}/${target.path}${lines}`;
    }
  }
}

export function describeWebReferenceTarget(target: WebReferenceTarget): string[] {
  if (target.provider === "web") return ["Type: Web page"];
  if (target.provider === "hacker-news")
    return ["Type: Hacker News item", `Item: ${target.itemId}`];
  const lines = [
    `Type: GitHub ${target.kind.replaceAll("-", " ")}`,
    `Repository: ${target.owner}/${target.repository}`,
  ];
  if ("number" in target) lines.push(`Number: ${target.number}`);
  if ("revision" in target) lines.push(`Revision: ${target.revision}`);
  if (target.kind === "file") {
    lines.push(`Revision or branch: ${target.ref}`);
    lines.push(`Path: ${target.path}`);
    if (target.lines)
      lines.push(
        `Lines: ${target.lines.start}${target.lines.end === target.lines.start ? "" : `-${target.lines.end}`}`,
      );
  }
  return lines;
}
