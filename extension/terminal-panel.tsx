import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  TerminalHostState,
  TerminalIntent,
  TerminalPanelProps,
} from "../widget/messenger.js";

function terminalPath(value: string): {
  leading: string;
  separator: string;
  trailing: string;
} {
  const complete = value.replaceAll("\\", "/");
  const boundary = complete.lastIndexOf("/");
  if (boundary < 0)
    return { leading: complete, separator: "", trailing: "" };
  return {
    leading: complete.slice(0, boundary),
    separator: "/",
    trailing: complete.slice(boundary + 1),
  };
}

function TerminalPath({ value }: { value: string }): JSX.Element {
  const path = terminalPath(value);
  return (
    <small class="vw-terminal-path" title={value}>
      <span>{path.leading}</span>
      {path.separator ? <i>{path.separator}</i> : null}
      {path.trailing ? <b>{path.trailing}</b> : null}
    </small>
  );
}

function TerminalViewer({
  attachment,
}: {
  attachment: NonNullable<TerminalHostState["attachment"]>;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading terminal…");
  useEffect(() => {
    if (!root.current) return;
    let disposed = false;
    let disposeRuntime = (): void => undefined;
    void Promise.all([
      import("@volter-ai-dev/supercode-terminal/client"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm"),
    ])
      .then(([{ TerminalClient }, { FitAddon }, { Terminal }]) => {
        if (disposed || !root.current) return;
        const terminal = new Terminal({
          convertEol: false,
          cursorBlink: attachment.mode === "control",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
          scrollback: 5_000,
          theme: {
            background: "#111315",
            cursor: "#e6e8ea",
            foreground: "#e6e8ea",
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(root.current);
        fit.fit();
        const client = new TerminalClient({
          baseUrl: attachment.baseUrl,
          cols: terminal.cols,
          rows: terminal.rows,
          terminalId: attachment.id,
        });
        const socket = client.connect();
        const input =
          attachment.mode === "control"
            ? terminal.onData((data) => client.write(data))
            : null;
        socket.onopen = () =>
          setStatus(
            attachment.mode === "control"
              ? "Live · interactive"
              : "Live · read-only",
          );
        socket.onmessage = (event) => {
          try {
            const message = client.parse(String(event.data));
            if (message.type === "output") terminal.write(message.data);
            else if (message.type === "hello")
              terminal.resize(message.cols, message.rows);
            else if (
              message.type === "error" ||
              message.type === "input-rejected"
            )
              terminal.writeln(`\r\n${message.message}`);
            else if (message.type === "exit") setStatus("Terminal exited");
          } catch (error) {
            setStatus(
              error instanceof Error
                ? error.message
                : "Terminal stream failed",
            );
          }
        };
        socket.onerror = () => setStatus("Terminal connection failed");
        socket.onclose = () =>
          setStatus((current) =>
            current === "Terminal exited" ? current : "Terminal disconnected",
          );
        disposeRuntime = () => {
          socket.onclose = null;
          socket.onerror = null;
          socket.onmessage = null;
          socket.onopen = null;
          input?.dispose();
          client.close();
          terminal.dispose();
        };
      })
      .catch((error: unknown) => {
        if (!disposed)
          setStatus(
            error instanceof Error
              ? error.message
              : "Could not load the terminal viewer",
          );
      });
    return () => {
      disposed = true;
      disposeRuntime();
    };
  }, [attachment.id, attachment.mode]);
  return (
    <>
      <div class="vw-terminal-status" role="status">
        {status}
      </div>
      <div class="vw-terminal-screen" ref={root} />
    </>
  );
}

export function TerminalPanel({
  state,
  send,
  onClose,
}: TerminalPanelProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus({ preventScroll: true }), []);
  const dispatch = (intent: TerminalIntent): void => {
    setPending(true);
    void Promise.resolve(send(intent)).finally(() => setPending(false));
  };
  return (
    <section
      class="vw-terminal-panel"
      aria-label="Terminal sessions"
      aria-modal="true"
      role="dialog"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || state.attachment) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header>
        <button
          ref={closeButton}
          type="button"
          aria-label="Close terminals"
          onClick={onClose}
        >
          ←
        </button>
        <span>
          <strong>Terminals</strong>
          <small>Local tmux sessions</small>
        </span>
        {!state.attachment ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => dispatch({ action: "terminalRefresh" })}
          >
            Refresh
          </button>
        ) : null}
      </header>
      {state.attachment ? (
        <div class="vw-terminal-live">
          <TerminalViewer attachment={state.attachment} />
          <button
            type="button"
            onClick={() => dispatch({ action: "terminalDismiss" })}
          >
            Back to terminals
          </button>
        </div>
      ) : (
        <>
          <div class="vw-terminal-create">
            <button
              type="button"
              disabled={pending || !state.available}
              onClick={() =>
                dispatch({ action: "terminalCreate", harness: "claude-code" })
              }
            >
              New Claude Code
            </button>
            <button
              type="button"
              disabled={pending || !state.available}
              onClick={() =>
                dispatch({ action: "terminalCreate", harness: "codex" })
              }
            >
              New Codex
            </button>
          </div>
          {state.error ? (
            <div class="vw-terminal-error" role="alert">
              {state.error}
            </div>
          ) : null}
          <div class="vw-terminal-list">
            {state.sessions.map((session) => (
              <article key={session.id}>
                <span>
                  <strong>{session.label}</strong>
                  <TerminalPath
                    value={
                      session.cwd ?? session.activeCommand ?? "tmux session"
                    }
                  />
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    dispatch({
                      action: "terminalAttach",
                      mode: "observe",
                      sessionId: session.id,
                    })
                  }
                >
                  View
                </button>
                {session.owned ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      dispatch({
                        action: "terminalAttach",
                        mode: "control",
                        sessionId: session.id,
                      })
                    }
                  >
                    Control
                  </button>
                ) : null}
                {session.owned ? (
                  <button
                    type="button"
                    class="vw-danger"
                    disabled={pending}
                    onClick={() =>
                      dispatch({
                        action: "terminalClose",
                        sessionId: session.id,
                      })
                    }
                  >
                    Stop
                  </button>
                ) : null}
              </article>
            ))}
          </div>
          {!state.sessions.length && state.available ? (
            <p class="vw-terminal-empty">No tmux sessions are running.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
