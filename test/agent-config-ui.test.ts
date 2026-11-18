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
    models: ["prov-a", "prov-b"], defaultModel: "prov-a", efforts: ["low", "medium", "high", "xhigh", "max"],
    agents: [
      { paneId: "p1", title: "智能体一", status: "idle", input: "" },
      { paneId: "p2", title: "智能体二", status: "idle", input: "hello draft" },
      { paneId: "p3", title: "智能体三", status: "working", input: null },
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
  expect(list.children).toHaveLength(3);
  const boxes = list.children.map((row: any) => row.children[0].children[0]);
  expect(boxes.map((box: any) => box.checked)).toEqual([true, false, false]);
  expect(list.children.map((row: any) => row.children[1].textContent)).toEqual(["输入框空", "hello draft", "输入框读不到"]);
  expect(env.get("agent-model").children).toHaveLength(3);
  expect(env.get("agent-effort").children).toHaveLength(6);
  env.get("agent-model").value = "prov-b";
  env.get("agent-effort").value = "high";
  env.get("agent-config-apply").handlers.click();
  await env.flush();
  expect(env.applies).toEqual([{ panes: ["p1"], model: "prov-b", effort: "high" }]);
  const results = env.get("agent-config-results");
  expect(results.children).toHaveLength(1);
  expect(results.children[0].className).toBe("agent-config-result ok");
  expect(results.children[0].textContent).toBe("智能体一 — 已发送");
  expect(env.get("settings-status").textContent).toBe("批量应用完成。");
  boxes[0].checked = false;
  boxes[0].handlers.change();
  env.get("agent-config-apply").handlers.click();
  await env.flush();
  expect(env.applies).toHaveLength(1);
  expect(env.get("settings-status").textContent).toBe("请先勾选至少一个 agent，并选择模型或思考等级。");
});

test("settings bulk agent config stays hidden in shell mode", async () => {
  const env = setup("shell");
  env.get("settings-toggle").handlers.click();
  await env.flush();
  expect(env.get("settings-agents").hidden).toBe(true);
  expect(env.get("agent-config-list").children).toHaveLength(0);
});