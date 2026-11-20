import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["i18n", "settings-ui"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import[^;]*;\n/gm, "").replaceAll("export ", "")).join("\n"),
);

function setup(mode = "herdr") {
  const nodes = new Map<string, any>();
  const applies: any[] = [];
  const create = () => ({
    value: "", hidden: true, textContent: "", checked: false, disabled: false, children: [] as any[], dataset: {} as Record<string, string>, attributes: {} as Record<string, string>, handlers: {} as Record<string, Function>,
    addEventListener(name: string, fn: Function) { this.handlers[name] = fn; },
    append(...items: any[]) { this.children.push(...items); },
    replaceChildren(...items: any[]) { this.children = items; },
    setAttribute(k: string, v: string) { this.attributes[k] = v; },
    reset() {}, focus() {}, select() {}, click() {},
  });
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, create()); return nodes.get(id); };
  const options = {
    targetId: "local", models: ["org/chat"], defaultModel: "org/chat", efforts: ["low", "medium", "high", "xhigh", "max"],
    modelChoices: [
      { provider: "openai", id: "org/chat", name: "Chat", selector: "org/chat(openai)", multipleRoutes: false },
      { provider: "anthropic", id: "org/chat", name: "Other", selector: "org/chat(anthropic)", multipleRoutes: false },
    ],
    agents: [
      { workspaceId: "w9", workspace: "同名", paneId: "p1", title: "智能体一", status: "idle", input: "" },
      { workspaceId: "w9", workspace: "同名", paneId: "p2", title: "智能体二", status: "idle", input: "hello draft" },
      { workspaceId: "w9", workspace: "同名", paneId: "p3", title: "智能体三", status: "working", input: null },
      { workspaceId: "w9", workspace: "同名", paneId: "p4", title: "智能体四", status: "done", input: "" },
      { workspaceId: "w1", workspace: "同名", paneId: "p5", title: "智能体五", status: "idle", input: "" },
      { workspaceId: "w1", workspace: "同名", paneId: "p6", title: "智能体六", status: "idle", input: null },
      { workspaceId: "w2", workspace: "待确认", paneId: "p7", title: "智能体七", status: "blocked", input: "" },
    ],
  };
  const context: any = {
    agentNotificationsSupported: () => false,
    requestAgentNotificationPermission: async () => "denied",
    syncAgentNotifications() {},
    HTML_INTERACTIVE_KEY: "interactive", htmlInteractiveEnabled: () => true, setHtmlInteractive() {},
    NOTIFY_DONE_KEY: "done", NOTIFY_BLOCKED_KEY: "blocked", notifyDoneEnabled: () => false, notifyBlockedEnabled: () => false, setNotifyDone() {}, setNotifyBlocked() {},
    document: { getElementById: get, createElement: create, addEventListener() {}, querySelectorAll: () => [], documentElement: { lang: "" } },
    window: { addEventListener() {} },
    setTimeout, clearTimeout,
    localStorage: { getItem: () => "zh-CN", setItem() {} },
    fetch: async (url: string, init?: any) => {
      if (url === "/api/herdr/targets") return { ok: true, json: async () => ({ mode, active: "local", targets: [] }) };
      if (url === "/api/agent-config/options") return { ok: true, json: async () => options };
      if (url === "/api/agent-config/apply") { applies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ results: [{ paneId: "p1", title: "智能体一", ok: true, reason: "sent" }] }) }; }
      if (url === "/api/version") return { ok: true, json: async () => ({ version: "v0.0.41", commit: "abc1234", dirty: false }) };
      throw new Error(`Unexpected request ${url}`);
    },
  };
  runInNewContext(source + "\nsetupSettings({ setSwitching() {} });", context);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  return { get, applies, flush, options };
}

test("settings bulk agent config defaults checks to idle empty-input qwen rows and applies selection", async () => {
  const env = setup();
  env.get("settings-toggle").handlers.click();
  await env.flush();
  expect(env.get("settings-agents").hidden).toBe(false);
  const list = env.get("agent-config-list");
  const [all, first, second, blocked] = list.children;
  expect(list.children.slice(1).map((group: any) => group.dataset.workspace)).toEqual(["w9", "w1", "w2"]);
  const checkbox = (el: any) => el.children[0].children[0];
  const change = (el: any, checked: boolean) => { checkbox(el).checked = checked; checkbox(el).handlers.change(); };
  expect(checkbox(all).checked).toBe(true);
  expect(checkbox(blocked).disabled).toBe(true);
  const rows = first.children[1].children;
  expect(rows.map((row: any) => checkbox(row).checked)).toEqual([true, false, false, true]);
  expect(checkbox(rows[2]).disabled).toBe(true);
  change(rows[0], false);
  expect(checkbox(all).indeterminate).toBe(true);
  expect(checkbox(first).indeterminate).toBe(true);
  expect(checkbox(second).checked).toBe(true);
  expect(first.children[0].children[1].textContent).toContain("1/2");
  change(all, false);
  change(first, true);
  expect(checkbox(second).checked).toBe(false);
  change(all, true);
  expect(rows.map((r: any) => checkbox(r).checked)).toEqual([true, false, false, true]);
  expect(second.children[1].children.map((r: any) => checkbox(r).checked)).toEqual([true, false]);
  expect(all.children[0].children[1].textContent).toContain("3/3");
  expect(env.applies).toHaveLength(0);
  change(second, false);
  change(rows[3], false);
  const [, openai, anthropic] = env.get("agent-model").children;
  expect([openai.label, anthropic.label]).toEqual(["openai", "anthropic"]);
  expect(openai.children[0].textContent).toBe("Chat — org/chat");
  expect(anthropic.children[0].value).toBe("org/chat(anthropic)");
  expect(env.get("agent-effort").children).toHaveLength(6);
  env.get("agent-model").value = anthropic.children[0].value;
  env.get("agent-effort").value = "high";
  env.get("agent-config-apply").handlers.click();
  await env.flush();
  expect(env.applies).toEqual([{ targetId: "local", panes: ["p1"], model: "org/chat(anthropic)", effort: "high" }]);
  const results = env.get("agent-config-results");
  expect(results.children).toHaveLength(1);
  expect(results.children[0].className).toBe("agent-config-result ok");
  expect(results.children[0].textContent).toBe("智能体一 — 已发送");
  expect(env.get("settings-status").textContent).toBe("批量应用完成。");
  change(list.children[0], false);
  env.get("agent-config-apply").handlers.click();
  await env.flush();
  expect(env.applies).toHaveLength(1);
  expect(env.get("settings-status").textContent).toBe("请先勾选至少一个 agent，并选择模型或思考等级。");
});

test("apply sends every eligible pane once even when the selection exceeds one request", async () => {
  const env = setup();
  env.options.agents = Array.from({ length: 70 }, (_, i) => ({ ...env.options.agents[0]!, paneId: `p${i}` }));
  env.get("settings-toggle").handlers.click();
  await env.flush();
  env.get("agent-effort").value = "medium";
  env.get("agent-config-apply").handlers.click();
  await env.flush();
  expect(env.applies.length).toBeGreaterThan(1);
  expect(env.applies.flatMap(r => r.panes)).toEqual(env.options.agents.map(a => a.paneId));
  expect(env.applies.every(r => r.panes.length <= 64 && r.targetId === "local" && r.effort === "medium" && !("model" in r))).toBe(true);
});

test("settings bulk agent config stays hidden in shell mode", async () => {
  const env = setup("shell");
  env.get("settings-toggle").handlers.click();
  await env.flush();
  expect(env.get("settings-agents").hidden).toBe(true);
  expect(env.get("agent-config-list").children).toHaveLength(0);
});