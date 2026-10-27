import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["i18n", "preview-edits", "preview-source", "preview-edit-selection", "preview-edit-ui"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", "")).join("\n"),
);
function node(): any {
  return {
    value: "", textContent: "", hidden: false, checked: false, disabled: false, children: [], events: {} as Record<string, Function>,
    addEventListener(name: string, fn: Function) { this.events[name] = fn; },
    append(...items: unknown[]) { this.children.push(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    add(item: unknown) { this.children.push(item); },
    querySelectorAll() { return []; },
    focus() {}, select() {}, setAttribute() {}, classList: { toggle() {}, remove() {} },
  };
}
const anchor = { text: "selected", heading: "Heading", before: "before", after: "after", locator: "p", lineStart: 1, lineEnd: 1 };
function setup(storage = new Map<string, string>(), delivery = { state: "sent" }, origin: unknown = null) {
  const elements = new Map<string, any>(), requests: any[] = [];
  let finish: (() => void) | undefined;
  let defer = false;
  let available: any[] = [];
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const context: any = {
    document: { getElementById: get, createElement: node, body: node() },
    window: { addEventListener() {}, dispatchEvent() {} },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    crypto, Uint8Array, structuredClone,
    Option: function(this: any, text: string, value: string) { this.textContent = text; this.value = value; },
    fetch: async (path: string, options: any) => {
      if (path.includes("/agents")) return { ok: true, json: async () => ({ agents: available }) };
      requests.push(JSON.parse(options.body));
      if (defer) await new Promise<void>(resolve => { finish = resolve; });
      return { ok: true, json: async () => delivery };
    },
  };
  context.originAgent = origin;
  runInNewContext(source + '\nglobalThis.ui = new PreviewEditController("/document.md", "markdown", originAgent);', context);
  const ui = context.ui;
  ui.agents = [{ targetId: "local", connection: "local", paneId: "p1", workspace: "Documents", cwd: "/", title: "editor", status: "idle", session: "a".repeat(64) }];
  return { ui, get, requests, storage, list: (agents: any[]) => { available = agents; }, defer: () => { defer = true; }, finish: () => finish!() };
}

test("origin agent is preselected by immutable identity; manual choice survives refresh, reordering and reload", async () => {
  const origin = { targetId: "local", paneId: "p1", session: "a".repeat(64) };
  const env = setup(new Map(), { state: "sent" }, origin);
  const first = { ...env.ui.agents[0] };
  const second = { ...first, targetId: "abcd1234", paneId: "p2", session: "b".repeat(64), connection: "Remote", title: "Remote editor" };
  env.list([second, first]); await env.ui.refreshAgents();
  expect(env.ui.selectedAgent().session).toBe(origin.session);
  expect(env.requests).toHaveLength(0);
  env.get("edit-agent").value = "1"; env.get("edit-agent").events.change();
  env.list([first, second]); await env.ui.refreshAgents();
  expect(env.ui.selectedAgent().title).toBe("Remote editor");
  const restored = setup(env.storage, { state: "sent" }, origin);
  restored.list([second, first]); await restored.ui.refreshAgents();
  expect(restored.ui.selectedAgent().title).toBe("Remote editor");
  expect(restored.requests).toHaveLength(0);
});

test("direct, stale and replaced origins stay unselected; busy origin remains selected without sending", async () => {
  const direct = setup(); const first = { ...direct.ui.agents[0] };
  direct.list([first]); await direct.ui.refreshAgents();
  expect(direct.get("edit-agent").value).toBe("");
  const stale = setup(new Map(), { state: "sent" }, { targetId: "local", paneId: "p1", session: "f".repeat(64) });
  stale.list([first]); await stale.ui.refreshAgents();
  expect(stale.get("edit-agent").value).toBe("");
  const busy = setup(new Map(), { state: "sent" }, first);
  busy.list([{ ...first, status: "working" }]); await busy.ui.refreshAgents();
  expect(busy.ui.selectedAgent().status).toBe("working");
  busy.ui.beginEdit(anchor); busy.get("edit-instruction").value = "change"; busy.ui.saveEdit();
  expect(busy.get("edit-send").disabled).toBe(true);
  await busy.ui.send(); expect(busy.requests).toHaveLength(0);
  busy.list([{ ...first, session: "c".repeat(64) }]); await busy.ui.refreshAgents();
  expect(busy.get("edit-agent").value).toBe("");
});

test("draft selection, instruction and optional replacement survive reload; list edits and deletions update prompt", () => {
  const first = setup(); first.ui.beginEdit(anchor);
  first.get("edit-instruction").value = "update this"; first.ui.saveCurrent();
  first.get("edit-use-replacement").checked = true;
  first.get("edit-replacement").value = "new <text>"; first.ui.saveCurrent();
  const restored = setup(first.storage);
  expect(restored.get("edit-instruction").value).toBe("update this");
  expect(restored.get("edit-replacement").value).toBe("new <text>");
  restored.ui.saveEdit();
  expect(restored.get("edit-prompt").value).toContain('"suggestedReplacement": "new <text>"');
  const item = restored.get("edit-list").children[0];
  item.children[1].children[0].events.click();
  restored.get("edit-instruction").value = "changed"; restored.ui.saveEdit();
  expect(restored.get("edit-prompt").value).toContain('"userRequest": "changed"');
  restored.get("edit-list").children[0].children[1].children[1].events.click();
  expect(restored.get("edit-prompt").value).toBe("");
  expect(restored.requests).toHaveLength(0);
});

test("delivery requires explicit selection and click, blocks double-click and retains sent draft after reload", async () => {
  const env = setup(); env.ui.beginEdit(anchor);
  env.get("edit-instruction").value = "change"; env.ui.saveEdit();
  await env.ui.send(); expect(env.requests).toHaveLength(0);
  env.get("edit-agent").value = "0"; env.defer();
  const sending = env.ui.send(); await Promise.resolve();
  await env.ui.send(); expect(env.requests).toHaveLength(1);
  env.finish(); await sending;
  expect(env.get("edit-status").textContent).toContain("提示词已投递");
  expect(env.ui.doc.edits).toHaveLength(1);
  const restored = setup(env.storage); restored.get("edit-agent").value = "0";
  await restored.ui.send(); expect(restored.requests).toHaveLength(0);
  expect(restored.get("edit-send").disabled).toBe(true);
});

test("editing one item preserves the order of the change list", () => {
  const env = setup();
  for (const text of ["first", "second"]) {
    env.ui.beginEdit({ ...anchor, text }); env.get("edit-instruction").value = text; env.ui.saveEdit();
  }
  env.ui.beginEdit(env.ui.doc.edits[0].anchor, env.ui.doc.edits[0]);
  env.get("edit-instruction").value = "updated first"; env.ui.saveEdit();
  expect(env.ui.doc.edits.map((e: any) => e.instruction)).toEqual(["updated first", "second"]);
});

test("busy agents never receive a request; uncertain delivery reuses the same request identity", async () => {
  const busy = setup(); busy.ui.beginEdit(anchor); busy.get("edit-instruction").value = "change"; busy.ui.saveEdit();
  busy.get("edit-agent").value = "0"; busy.ui.agents[0].status = "working";
  await busy.ui.send(); expect(busy.requests).toHaveLength(0); expect(busy.ui.doc.edits).toHaveLength(1);
  const uncertain = setup(new Map(), { state: "uncertain" });
  uncertain.ui.beginEdit(anchor); uncertain.get("edit-instruction").value = "change"; uncertain.ui.saveEdit(); uncertain.get("edit-agent").value = "0";
  await uncertain.ui.send(); await uncertain.ui.send();
  expect(uncertain.requests).toHaveLength(2);
  expect(uncertain.requests[0].requestId).toBe(uncertain.requests[1].requestId);
  expect(uncertain.get("edit-list").children[0].children[1].children[0].disabled).toBe(true);
});
