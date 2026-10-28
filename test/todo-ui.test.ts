import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["i18n", "preview-edits", "preview-source", "todos", "todo-ui"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", "")).join("\n"),
);
function setup(delivery = "sent") {
  const nodes = new Map<string, any>(), calls: any[] = [];
  const node = () => ({ value: "", textContent: "", checked: false, hidden: true, disabled: false, children: [] as any[], attributes: {} as Record<string, string>, handlers: {} as Record<string, Function>,
    addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }, replaceChildren(...items: any[]) { this.children = items; }, append(...items: any[]) { this.children.push(...items); }, setAttribute(k: string, v: string) { this.attributes[k] = v; }, getAttribute(k: string) { return this.attributes[k]; }, contains() { return false; }, focus() {}, select() {}, style: { setProperty() {} } });
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let deferred = false, finish: (() => void) | undefined;
  const agent = { targetId: "local", paneId: "p1", session: "a".repeat(64), connection: "Local", workspace: "Documents", title: "Editor", status: "idle", cwd: "/" };
  let agents = [agent];
  const context: any = { document: { getElementById: get, createElement: node, addEventListener() {} }, window: { addEventListener() {} }, localStorage: { getItem: () => "zh-CN" }, location: { origin: "http://127.0.0.1:24866" }, crypto, Uint8Array, Date, Option: function(this: any, text: string, value: string) { this.text = text; this.value = value; },
    fetch: async (url: string, options: any) => {
      const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method: options.method, body });
      let result: any;
      if (url.endsWith("/agents")) result = { agents, source: agent };
      else if (url.endsWith("/grants")) result = { grants: [] };
      else if (url.endsWith("/prompt")) result = { grantId: "b".repeat(32), projectId: null, expiresAt: Date.now() + 60000, prompt: "<test prompt; no credential>" };
      else if (url.endsWith("/send")) { if (deferred) await new Promise<void>(r => { finish = r; }); result = { state: delivery }; }
      else result = { revision: 0, projects: [], items: [] };
      return { ok: true, json: async () => result };
    },
  };
  runInNewContext(source + "\nglobalThis.ui = new TodoController();", context);
  const ui = context.ui;
  return { ui, get, calls, agents: (value: any[]) => { agents = value; }, defer: () => { deferred = true; }, finish: () => finish!() };
}

test("todo prompt generation is explicit, scoped and never sends automatically; busy agent is disabled", async () => {
  const env = setup();
  env.get("todo-base-url").value = "http://127.0.0.1:24866"; env.get("todo-ttl").value = "3600";
  await expect(env.ui.generate()).rejects.toThrow("invalid_scope");
  expect(env.calls).toHaveLength(0);
  env.get("todo-all-scope").checked = true;
  await env.ui.refreshAgents(); await env.ui.generate();
  expect(env.get("todo-prompt-text").value).toBe("<test prompt; no credential>");
  expect(env.calls.find(c => c.url.endsWith("/prompt"))?.body).toMatchObject({ projectId: null, ttlSeconds: 3600 });
  expect(env.calls.some(c => c.url.endsWith("/send"))).toBe(false);
  env.ui.agents[0].status = "working"; env.ui.renderSend();
  expect(env.get("todo-send").disabled).toBe(true);
  await env.ui.send(); expect(env.calls.some(c => c.url.endsWith("/send"))).toBe(false);
});

test("todo send prevents double clicks and pins uncertain retries to the original request and agent", async () => {
  const env = setup("uncertain"); env.get("todo-all-scope").checked = true; env.get("todo-base-url").value = "http://127.0.0.1:24866"; env.get("todo-ttl").value = "3600";
  await env.ui.refreshAgents(); await env.ui.generate(); env.defer();
  const first = env.ui.send(); await Promise.resolve(); await env.ui.send();
  expect(env.calls.filter(c => c.url.endsWith("/send"))).toHaveLength(1);
  env.finish(); await first;
  expect(env.get("todo-agent").disabled).toBe(true);
  const original = env.calls.find(c => c.url.endsWith("/send"))!.body;
  const retry = env.ui.send(); await Promise.resolve(); env.finish(); await retry;
  expect(env.calls.filter(c => c.url.endsWith("/send"))[1].body).toEqual(original);
  env.ui.clearPrompt(); expect(env.get("todo-prompt-text").value).toBe(""); expect(env.get("todo-agent").disabled).toBe(false);
});

test("manual todo agent selection survives refresh; delivered or expired prompts cannot be sent again", async () => {
  const env = setup(); const other = { targetId: "abcdef12", paneId: "p2", session: "c".repeat(64), connection: "Remote", workspace: "Docs", title: "Other editor", status: "idle", cwd: "/" };
  await env.ui.refreshAgents(); env.agents([other]); await env.ui.refreshAgents(); env.get("todo-agent").value = env.ui.identity(other); env.get("todo-agent").handlers.change();
  await env.ui.refreshAgents(); expect(env.get("todo-agent").value).toBe(env.ui.identity(other));
  env.get("todo-all-scope").checked = true; env.get("todo-base-url").value = "http://127.0.0.1:24866"; env.get("todo-ttl").value = "3600"; await env.ui.generate();
  await env.ui.send(); await env.ui.send(); expect(env.calls.filter(c => c.url.endsWith("/send"))).toHaveLength(1);
  expect(env.get("todo-status").textContent).toContain("投递成功不代表任务完成");
  expect(env.get("todo-status").textContent).not.toContain("预览");
  env.ui.delivered = false; env.ui.generated.expiresAt = Date.now() - 1; env.ui.renderSend();
  expect(env.get("todo-send").disabled).toBe(true); expect(env.get("todo-copy").disabled).toBe(true);
});
