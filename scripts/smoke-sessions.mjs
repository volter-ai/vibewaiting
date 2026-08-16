#!/usr/bin/env node
// Browser-free smoke for milestone 2: does the REAL transport answer the two questions the Sessions
// list is built on?
//
//   1. global discovery — `discover({ limit })` with NO workspace, across every harness and project;
//   2. attach — pointing a controller at one of those sessions, the way the daemon does it: a
//      second, non-owning `SupercodeController` scoped to that session's own workspace, `observe`d
//      into a read-only mirror, then closed.
//
// It NEVER sends input to a discovered session — mirroring is a read, and this script stays one.
// Run it with `npm run build && node scripts/smoke-sessions.mjs [--harness claude-code]` — it renders
// through the SHIPPED projection (`dist/sessions.js`), so what it prints is what the panel would show.
import { SupercodeHarnessClient } from "@volter-ai-dev/supercode-harness-sdk";
import { SupercodeController } from "@volter-ai-dev/supercode-client";
import { projectSessions, sessionKey } from "../dist/sessions.js";

const harnessArg = process.argv.includes("--harness")
  ? process.argv[process.argv.indexOf("--harness") + 1]
  : "claude-code";
const FOLLOW_MS = 2000;

const client = new SupercodeHarnessClient({ cwd: process.cwd() });
let controller = null;

try {
  // ── 1. the global scan ────────────────────────────────────────────────────────────────────────
  const started = Date.now();
  const { sessions } = await client.discover({ limit: 30 });
  console.log(`discover({ limit: 30 }) with no workspace → ${sessions.length} sessions in ${Date.now() - started}ms`);
  const rows = projectSessions(sessions, { now: Date.now(), home: process.env.HOME ?? "" });
  for (const row of rows.slice(0, 12)) {
    console.log(
      `  ${row.harness.padEnd(12)} ${(row.age || "—").padEnd(8)} ${row.name.padEnd(22)} ${row.title.slice(0, 44)}`,
    );
  }
  const workspaces = new Set(sessions.map((s) => s.cwd));
  console.log(`  → ${workspaces.size} distinct workspaces, ${new Set(sessions.map((s) => s.locator.harness)).size} harnesses`);

  // ── 2. the attach path ────────────────────────────────────────────────────────────────────────
  const target = sessions.find((s) => s.locator.harness === harnessArg && typeof s.cwd === "string");
  if (!target) {
    console.log(`\nno ${harnessArg} session with a workspace to attach to — skipping the attach half`);
  } else {
    console.log(`\nattaching to ${harnessArg} ${sessionKey(target.locator)} in ${target.cwd}`);
    controller = new SupercodeController({ client, workspace: target.cwd, ownsClient: false });
    await controller.initialize();
    const visible = controller
      .getSnapshot()
      .sessions.find(
        (s) => s.harness === target.locator.harness && s.sessionId === target.locator.session_id,
      );
    if (!visible) throw new Error(`the controller cannot see that session in ${target.cwd}`);
    await controller.dispatch({ type: "observe", sessionKey: visible.key });

    const first = controller.getSnapshot();
    console.log(
      `  observe → connection.mode=${first.connection.mode} follow=${first.connection.follow}` +
        ` canSend=${first.availableActions.send} conversation=${first.conversation.length} entries`,
    );
    console.log(`  first entry kind: ${first.conversation[0]?.kind ?? "(none)"}`);

    let revisions = 0;
    const unsubscribe = controller.subscribe(() => {
      revisions += 1;
    });
    await new Promise((r) => setTimeout(r, FOLLOW_MS));
    unsubscribe();
    const after = controller.getSnapshot();
    console.log(
      `  after ${FOLLOW_MS}ms following: ${revisions} revisions, ${after.conversation.length} entries,` +
        ` error=${after.error?.message ?? "none"}`,
    );
    console.log(`  last entry: ${(after.conversation.at(-1)?.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`);
  }
} catch (e) {
  console.error(`smoke FAILED: ${e?.message ?? e}`);
  if (client.stderr) console.error(`supercode stderr:\n${client.stderr.slice(0, 2000)}`);
  process.exitCode = 1;
} finally {
  // Closing the mirror aborts its follower; the transport is closed separately because the mirror
  // never owned it (`ownsClient: false`) — exactly the daemon's ownership split.
  if (controller) await controller.close().catch(() => undefined);
  await client.close();
  console.log("\nclosed cleanly");
}
