#!/usr/bin/env bun
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.SHELT_EDIT_FIXTURE!;
const args = process.argv.slice(2);
const control = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
const remote = process.env.EDIT_REMOTE === "1";
if (args[0] === "--session") args.splice(0, 2);
const agent = {
  terminal_id: control.terminal || "terminal-1", pane_id: "w1:p1", workspace_id: "docs", tab_id: "t1", agent: "qwen",
  terminal_title_stripped: remote ? "remote editor" : "local editor", cwd: directory,
  agent_status: control.status || "idle", launch_pending: control.launchPending || false,
  agent_session: { value: control.session || "native-session-1" },
};
if (control.unavailable) { console.error("unsupported method"); process.exit(1); }
if (args[0] === "workspace" && args[1] === "list") {
  console.log(JSON.stringify({ result: { workspaces: [{ workspace_id: "docs", label: "Documents" }] } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "current") {
  console.log(JSON.stringify({ result: { pane: { pane_id: control.focusedPane || "w1:p1", cwd: directory } } }));
  process.exit(0);
}
if (args[0] !== "agent") { await new Promise(() => {}); }
if (args[1] === "list") {
  await appendFile(join(directory, "calls.jsonl"), JSON.stringify({ type: "list", remote, args }) + "\n");
  console.log(JSON.stringify({ result: { agents: control.empty ? [] : [agent] } }));
} else if (args[1] === "prompt") {
  const receipts = await readdir(join(process.env.SHELT_STATE_DIR!, "preview-edit-receipts"));
  const pending = await Promise.all(receipts.filter(f => f.endsWith(".json")).map(async f => JSON.parse(await readFile(join(process.env.SHELT_STATE_DIR!, "preview-edit-receipts", f), "utf8"))));
  if (!pending.some(r => r.state === "pending")) throw new Error("Prompt arrived before durable receipt");
  await appendFile(join(directory, "received.jsonl"), JSON.stringify({ paneId: args[2], text: args[3], remote, args: args.slice(0, 3), receiptWasPending: true }) + "\n");
  if (control.delay) await Bun.sleep(control.delay);
  if (control.reject) { console.error(JSON.stringify({ error: { code: "agent_blocked" } })); process.exit(1); }
  if (control.disconnect) process.exit(1);
  console.log(JSON.stringify({ result: { agent } }));
} else { console.error("unsupported method"); process.exit(1); }
