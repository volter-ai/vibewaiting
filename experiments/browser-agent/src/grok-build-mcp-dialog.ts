import type { GrokBuildMcpRegistry } from "./grok-build-mcp.js";

type McpSummary = ReturnType<GrokBuildMcpRegistry["serverSummaries"]>[number];

/** Browser-native equivalent of Grok Build's MCP Servers extensions tab. */
export class GrokBuildMcpDialog {
  private dialog: HTMLDialogElement | undefined;
  private action: AbortController | undefined;

  constructor(
    private readonly registry: () => GrokBuildMcpRegistry,
    private readonly doc: Document = document,
  ) {}

  open(): void {
    this.close();
    const dialog = this.doc.createElement("dialog");
    dialog.className = "grok-mcp-dialog";
    dialog.setAttribute("aria-label", "MCP servers");
    dialog.addEventListener("close", () => this.close());
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    this.doc.body.append(dialog);
    this.dialog = dialog;
    this.render();
    dialog.showModal();
  }

  close(): void {
    this.action?.abort(new DOMException("MCP dialog closed.", "AbortError"));
    this.action = undefined;
    const dialog = this.dialog;
    this.dialog = undefined;
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.remove();
  }

  private render(notice?: { error: boolean; text: string }): void {
    const dialog = this.dialog;
    if (!dialog) return;
    dialog.replaceChildren();
    const header = this.doc.createElement("header");
    const heading = this.doc.createElement("div");
    const title = this.doc.createElement("h2");
    title.textContent = "MCP servers";
    const detail = this.doc.createElement("p");
    detail.textContent = "Configured integrations and their live browser-session status.";
    heading.append(title, detail);
    const close = this.button("Close", "secondary", () => this.close());
    header.append(heading, close);
    dialog.append(header);

    if (notice) {
      const row = this.doc.createElement("p");
      row.className = notice.error ? "mcp-notice error" : "mcp-notice";
      row.textContent = notice.text;
      dialog.append(row);
    }

    const summaries = this.registry().serverSummaries();
    const list = this.doc.createElement("div");
    list.className = "mcp-server-list";
    if (summaries.length === 0) {
      const empty = this.doc.createElement("p");
      empty.className = "mcp-empty";
      empty.textContent = "No MCP servers are configured. Add them to /.grok/config.toml or a supported project MCP file.";
      list.append(empty);
    } else {
      for (const summary of summaries) list.append(this.serverRow(summary));
    }
    dialog.append(list);

    const footer = this.doc.createElement("footer");
    const refresh = this.button("Refresh all", "secondary", () => void this.runAll());
    footer.append(refresh);
    dialog.append(footer);
  }

  private serverRow(summary: McpSummary): HTMLElement {
    const row = this.doc.createElement("section");
    row.className = "mcp-server-row";
    row.dataset.status = summary.status;
    const body = this.doc.createElement("div");
    const heading = this.doc.createElement("div");
    heading.className = "mcp-server-heading";
    const name = this.doc.createElement("strong");
    name.textContent = summary.name;
    const status = this.doc.createElement("span");
    status.textContent = formatGrokBuildMcpStatus(summary);
    heading.append(name, status);
    const description = this.doc.createElement("p");
    description.textContent = summary.error ?? summary.description ?? (summary.toolNames.length ? summary.toolNames.join(", ") : "No tools registered");
    body.append(heading, description);
    const actions = this.doc.createElement("div");
    actions.className = "mcp-server-actions";
    actions.append(this.button(summary.status === "failed" ? "Retry" : "Refresh", "secondary", () => void this.run(summary.name, false)));
    if (summary.supportsAuthentication) actions.append(this.button("Authenticate", "", () => void this.run(summary.name, true)));
    row.append(body, actions);
    return row;
  }

  private button(label: string, className: string, action: () => void): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  private async run(serverName: string, authenticate: boolean): Promise<void> {
    this.action?.abort(new DOMException("A newer MCP action started.", "AbortError"));
    const controller = new AbortController();
    this.action = controller;
    this.render({ error: false, text: `${authenticate ? "Authenticating" : "Refreshing"} ${serverName}…` });
    try {
      if (authenticate) await this.registry().authenticate(serverName, controller.signal);
      else await this.registry().refresh(serverName, controller.signal);
      if (this.action === controller) this.render({ error: false, text: `${serverName} is ready.` });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (this.action === controller) this.render({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.action === controller) this.action = undefined;
    }
  }

  private async runAll(): Promise<void> {
    this.action?.abort(new DOMException("A newer MCP action started.", "AbortError"));
    const controller = new AbortController();
    this.action = controller;
    this.render({ error: false, text: "Refreshing MCP servers…" });
    try {
      const registry = this.registry();
      await Promise.allSettled(registry.serverSummaries().map((server) => registry.refresh(server.name, controller.signal)));
      controller.signal.throwIfAborted();
      if (this.action === controller) this.render({ error: false, text: "MCP server refresh complete." });
    } finally {
      if (this.action === controller) this.action = undefined;
    }
  }
}

export function formatGrokBuildMcpStatus(summary: Pick<McpSummary, "status" | "toolCount">): string {
  switch (summary.status) {
    case "idle": return "Not connected";
    case "connecting": return "Connecting…";
    case "failed": return "Connection failed";
    case "ready": return `${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`;
  }
}
