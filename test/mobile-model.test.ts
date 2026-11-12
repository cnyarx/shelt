import { expect, test } from "bun:test";
import { MobileSender, mobileKey, nativeAgents, validPane } from "../src/mobile-model.ts";
import { nativeBridgeCommand, nativeRequest } from "../src/mobile-service.ts";

test("native navigation preserves workspace/tab order, full names and status without reordering", () => {
  const snapshot = {
    focused_pane_id: "w9:p1",
    workspaces: [{ workspace_id: "w9", label: "先显示" }, { workspace_id: "w1", label: "后显示" }],
    tabs: [{ tab_id: "w9:t30", workspace_id: "w9", label: "完整标签三十" }, { tab_id: "w9:t1", workspace_id: "w9", label: "完整标签一" }, { tab_id: "w1:t2", workspace_id: "w1" }],
    agents: [
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent_status: "blocked", agent: "qwen" },
      { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", name: "自定义agent", agent_status: "idle" },
      { pane_id: "w9:p30", workspace_id: "w9", tab_id: "w9:t30", name: "全名 '<>&", terminal_title_stripped: "Qwen - admin", agent_status: "working" },
    ],
  };
  const agents = nativeAgents(snapshot);
  expect(agents.map(a => a.paneId)).toEqual(["w9:p30", "w9:p1", "w1:p2"]);
  expect(agents[0]!.title).toBe("先显示 · 完整标签三十 · 全名 '<>&");
  expect(agents[2]!.title).toBe("后显示 · w1:t2 · qwen");
  expect(snapshot.agents[0]!.pane_id).toBe("w1:p2");
});

test("native control only forwards bounded, explicitly supported Herdr operations", () => {
  for (const value of ["", "-x", "a;touch", "a\n", "../log"]) expect(validPane(value)).toBe(false);
  expect(validPane("w21:pA")).toBe(true);
  const request = (method: string, params = {}) => nativeRequest(JSON.stringify({ id: "test:1", method, params }));
  expect(JSON.parse(request("agent.focus", { target: "w1:p1", ignored: "removed" })!)).toEqual({ id: "test:1", method: "agent.focus", params: { target: "w1:p1" } });
  expect(JSON.parse(request("pane.focus", { pane_id: "w1:p1" })!)).toEqual({ id: "test:1", method: "pane.focus", params: { pane_id: "w1:p1" } });
  expect(request("pane.focus", { pane_id: "bad;id" })).toBeNull();
  expect(request("pane.focus", {})).toBeNull();
  expect(request("session.snapshot")).not.toBeNull();
  expect(request("pane.zoom", { pane_id: "w1:p1", mode: "toggle" })).not.toBeNull();
  expect(request("events.subscribe", { subscriptions: [{ type: "pane.focused" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }] })).not.toBeNull();
  for (const method of ["server.stop", "agent.prompt", "pane.send_text", "pane.close", "worktree.remove"]) expect(request(method)).toBeNull();
  expect(request("agent.focus", { target: "--help" })).toBeNull();
  expect(request("events.subscribe", { subscriptions: [{ type: "pane.agent_status_changed" }] })).toBeNull();
  expect(request("events.subscribe", { subscriptions: Array(1025).fill({ type: "pane.focused" }) })).toBeNull();
  expect(nativeRequest("{}\n{}")).toBeNull();
  expect(nativeRequest("x".repeat(65537))).toBeNull();
});

test("one native API bridge serves local and SSH targets without pane attach", () => {
  const launch = { mode: "herdr" as const, command: "/custom/herdr", args: [] };
  expect(nativeBridgeCommand(launch, null)).toEqual(["/custom/herdr", "remote-api-bridge"]);
  const remote = nativeBridgeCommand(launch, { id: "12345678", name: "remote", remote: "admin@fixture.test", session: "named-session" });
  expect(remote).toContain("-T"); expect(remote).toContain("admin@fixture.test");
  expect(remote.at(-1)).toContain("--session 'named-session' remote-api-bridge");
  expect(remote.join(" ")).not.toContain("takeover");
});

test("Ctrl+Y and mobile Ctrl inputs produce control bytes, never raw IME text", () => {
  expect(mobileKey("Ctrl+Y")).toBe("\x19");
  for (const key of ["y", "Y", "yes"]) expect(mobileKey(key, true)).toBe("\x19");
  expect(mobileKey("↓", true)).toBe("\x1b[1;5B");
  expect(mobileKey("Tab", true)).toBe("\t");
  expect(mobileKey("\x19", true)).toBe("\x19");
  expect(mobileKey("中文", true)).toBe("");
  expect(mobileKey("", true)).toBe("");
  expect(mobileKey("yes")).toBe("yes");
});

test("mobile keys and sender preserve paste boundaries, timing, cancellation and failure", async () => {
  expect(mobileKey("C", true)).toBe("\x03"); expect(mobileKey("Shift+Tab")).toBe("\x1b[Z"); expect(mobileKey("←")).toBe("\x1b[D");
  let now = 0; const writes: string[] = [], waits: number[] = [];
  const sender = new MobileSender(value => { writes.push(value); return true; }, async ms => { waits.push(ms); now += ms; }, () => now);
  expect(await sender.submit("中文\n'$(text)'\r\n")).toBe(true);
  expect(writes).toEqual(["\x1b[200~中文\n'$(text)'\n\x1b[201~", "\r"]); expect(waits).toEqual([120]);
  sender.key("\x1b"); expect(await sender.submit("after Esc")).toBe(true); expect(waits.at(-1)).toBe(300);
  let finish!: () => void; writes.length = 0;
  const pending = new MobileSender(value => { writes.push(value); return true; }, () => new Promise(r => { finish = r; }));
  const first = pending.submit("one"); expect(await pending.submit("two")).toBe(false); expect(pending.key("\r")).toBe(false);
  pending.cancel(); finish(); expect(await first).toBe(false); expect(writes).toHaveLength(1);
  expect(await sender.submit("bad\x1b[201~command")).toBe(false);
  expect(await new MobileSender(() => false).submit("offline")).toBe(false);
});
