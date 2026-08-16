#!/usr/bin/env node
// Browser-free smoke: does the installed `supercode` binary actually talk to the harness SDK we
// depend on? Launches `supercode harness serve` through the SDK, asks for the local harness
// inventory, prints it, and shuts down. Run it with `node scripts/smoke-harness.mjs [workspace]`.
//
// This is the ONE place that proves the transport half of the bridge without a browser; the widget
// half is proven by `npm test` (projection + daemon, both fake-client driven).
import { SupercodeHarnessClient } from "@volter-ai-dev/supercode-harness-sdk";

const workspace = process.argv[2] ?? process.cwd();
const client = new SupercodeHarnessClient({ cwd: workspace });

try {
  const caps = await client.capabilities();
  console.log(`supercode ${caps.version} — sdk ${caps.sdk?.schema_version}, harnesses: ${caps.harnesses.join(", ")}`);
  const { probe, harnesses } = await client.listHarnesses({ workspace, probe: "passive", include_sessions: false });
  console.log(`listHarnesses(probe=${probe}, workspace=${workspace}):`);
  for (const h of harnesses) {
    const marks = [h.installed ? "installed" : "absent", `auth=${h.auth}`, `runtime=${h.runtime}`];
    console.log(`  ${h.id.padEnd(12)} ${marks.join(" ")}${h.version ? ` (${h.version})` : ""}${h.reason ? ` — ${h.reason}` : ""}`);
  }
} catch (e) {
  console.error(`smoke FAILED: ${e?.message ?? e}`);
  if (client.stderr) console.error(`supercode stderr:\n${client.stderr.slice(0, 2000)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
