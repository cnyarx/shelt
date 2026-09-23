import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/preview-preferences.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/settings-ui.ts", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "")
    .replace("export function setupSettings", "function setupSettings")
    .replace("export function setSettingsVisible", "function setSettingsVisible"),
);

function fakeElement(tag = "div"): any {
  const element: any = {
    tagName: tag.toUpperCase(),
    children: [] as any[],
    parent: null,
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    className: "",
    title: "",
    type: "",
    attributes: {} as Record<string, string>,
    handlers: {} as Record<string, Function[]>,
    addEventListener(name: string, handler: Function) { (this.handlers[name] ??= []).push(handler); },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    append(...nodes: any[]) { for (const node of nodes) { node.parent = element; element.children.push(node); } },
    replaceChildren(...nodes: any[]) { element.children = []; element.append(...nodes); },
    contains(node: any) { for (let current = node; current; current = current.parent) if (current === element) return true; return false; },
    focus() {},
    select() {},
    reset() {},
  };
  return element;
}

const IDS = [
  "settings-toggle", "settings-panel", "settings-herdr", "target-list", "target-form",
  "target-name", "target-remote", "target-session", "target-submit", "target-cancel",
  "settings-status", "settings-version", "password-form", "current-password", "new-password", "confirm-new-password", "password-submit", "html-interactive",
  "ui-language", "target-add", "password-toggle", "password-cancel",
];

function flush(times = 6) {
  return Array.from({ length: times }, () => new Promise((resolve) => setTimeout(resolve, 0))).reduce(
    (chain, tick) => chain.then(() => tick),
    Promise.resolve(),
  );
}

test("settings panel manages targets, switches connection and changes password", async () => {
  const elements = new Map<string, any>();
  for (const id of IDS) elements.set(id, fakeElement(id === "target-list" ? "ul" : "div"));
  elements.get("settings-toggle").hidden = true;
  elements.get("settings-panel").hidden = true;
  const state = {
    mode: "herdr",
    active: "local",
    targets: [{ id: "abcd1234", name: "开发机", remote: "dev@10.0.0.2", session: "work" }],
  };
  const calls: { url: string; method: string; body?: any }[] = [];
  const switching: boolean[] = [];
  const preferences = new Map<string, string>();
  const storageHandlers: ((event: { key: string | null }) => void)[] = [];
  const storageChanged = (event: { key: string | null }) => storageHandlers.forEach(handler => handler(event));
  let confirmations = 0;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  runInNewContext(`${source}\nsetSettingsVisible(true);\nsetupSettings(options);`, {
    localStorage: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value) },
    window: { addEventListener: (_type: string, handler: typeof storageChanged) => { storageHandlers.push(handler); } },
    document: {
      documentElement: { lang: "" },
      querySelectorAll: () => [],
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => fakeElement(tag),
      addEventListener() {},
    },
    options: { setSwitching: (value: boolean) => switching.push(value) },
    confirm: () => { confirmations += 1; return true; },
    fetch: async (url: string, init: any = {}) => {
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/herdr/targets" && method === "GET") return ok({ ...state, targets: [...state.targets] });
      if (url === "/api/version" && method === "GET") return ok({ version: "开发版", commit: "464f2c5", dirty: true });
      if (url === "/api/herdr/targets" && method === "POST") {
        const entry = { id: "ef015678", ...body };
        state.targets.push(entry);
        return ok(entry);
      }
      if (url === "/api/herdr/active" && method === "POST") {
        state.active = body.id;
        return ok({ ok: true });
      }
      const editing = url.match(/^\/api\/herdr\/targets\/([a-f0-9]{8})$/);
      if (editing && method === "PUT") {
        Object.assign(state.targets.find((target) => target.id === editing[1])!, body);
        return ok(body);
      }
      if (editing && method === "DELETE") {
        state.targets = state.targets.filter((target) => target.id !== editing[1]);
        return ok({ ok: true });
      }
      if (url === "/api/auth/password" && method === "POST") return ok({ ok: true });
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });
  const get = (id: string) => elements.get(id);

  expect(get("html-interactive").checked).toBe(true);
  get("html-interactive").checked = false;
  get("html-interactive").handlers.change[0]();
  expect(preferences.get("shelt-html-interactive")).toBe("false");
  preferences.set("shelt-html-interactive", "true");
  storageChanged({ key: "shelt-html-interactive" });
  expect(get("html-interactive").checked).toBe(true);
  expect(get("settings-toggle").hidden).toBe(false);
  get("settings-toggle").handlers.click[0]();
  await flush();
  expect(get("settings-panel").hidden).toBe(false);
  expect(get("settings-version").textContent).toBe("Shelt 开发版 · 464f2c5 · 未提交改动");
  expect(get("settings-herdr").hidden).toBe(false);
  expect(get("target-form").hidden).toBe(true);
  expect(get("password-form").hidden).toBe(true);
  get("target-add").handlers.click[0]();
  expect(get("target-form").hidden).toBe(false);
  expect(get("target-add").attributes["aria-expanded"]).toBe("true");
  get("target-name").value = "编辑中";
  get("ui-language").value = "en";
  get("ui-language").handlers.change[0]();
  expect(preferences.get("shelt-language")).toBe("en");
  expect(get("target-submit").textContent).toBe("Add");
  expect(get("target-name").value).toBe("编辑中");
  expect(get("settings-version").textContent).toBe("Shelt Development · 464f2c5 · Uncommitted changes");
  expect(get("target-list").children[0].children[0].children[0].textContent).toBe("Local Herdr");
  expect(get("target-list").children[1].children[0].children[0].textContent).toBe("开发机");
  preferences.set("shelt-language", "zh-CN");
  storageChanged({ key: "shelt-language" });
  expect(get("ui-language").value).toBe("zh-CN");
  get("target-cancel").handlers.click[0]();
  expect(get("target-form").hidden).toBe(true);
  let rows = get("target-list").children;
  expect(rows.length).toBe(2);
  expect(rows[0].className).toContain("active");
  expect(rows[0].children[0].children[0].textContent).toBe("本机 Herdr");
  expect(rows[1].children[0].children[0].textContent).toBe("开发机");
  expect(rows[1].children[0].children[1].textContent).toBe("dev@10.0.0.2 · 会话 work");

  rows[1].children[0].handlers.click[0]({});
  await flush();
  expect(switching).toEqual([true]);
  expect(calls.at(-1)).toEqual({ url: "/api/herdr/active", method: "POST", body: { id: "abcd1234" } });
  expect(get("settings-panel").hidden).toBe(true);

  get("settings-toggle").handlers.click[0]();
  await flush();
  rows = get("target-list").children;
  expect(rows[1].className).toContain("active");
  rows[1].children[0].handlers.click[0]({});
  await flush();
  expect(calls.filter((call) => call.url === "/api/herdr/active").length).toBe(1);

  get("target-add").handlers.click[0]();
  expect(get("target-form").hidden).toBe(false);
  get("target-name").value = "备用机";
  get("target-remote").value = "ops@example.com";
  get("target-session").value = "";
  get("target-form").handlers.submit[0]({ preventDefault() {} });
  await flush();
  expect(calls.find((call) => call.url === "/api/herdr/targets" && call.method === "POST")?.body).toEqual({ name: "备用机", remote: "ops@example.com", session: null });
  expect(get("settings-status").textContent).toContain("已添加");
  expect(state.targets.length).toBe(2);
  expect(get("target-form").hidden).toBe(true);

  rows = get("target-list").children;
  const editButton = rows[2].children[1];
  editButton.handlers.click[0]({ stopPropagation() {} });
  expect(get("target-name").value).toBe("备用机");
  get("target-remote").value = "ops@example.net";
  get("target-form").handlers.submit[0]({ preventDefault() {} });
  await flush();
  expect(calls.find((call) => call.method === "PUT")?.body.remote).toBe("ops@example.net");
  expect(get("settings-status").textContent).toContain("已保存");

  const removeButton = get("target-list").children[2].children[2];
  removeButton.handlers.click[0]({ stopPropagation() {} });
  await flush();
  expect(confirmations).toBe(1);
  expect(calls.find((call) => call.method === "DELETE")).toEqual({ url: "/api/herdr/targets/ef015678", method: "DELETE", body: undefined });
  expect(state.targets.length).toBe(1);

  get("password-toggle").handlers.click[0]();
  expect(get("password-form").hidden).toBe(false);
  expect(get("target-form").hidden).toBe(true);
  expect(get("password-toggle").attributes["aria-expanded"]).toBe("true");
  get("password-cancel").handlers.click[0]();
  expect(get("password-form").hidden).toBe(true);
  get("password-toggle").handlers.click[0]();
  get("current-password").value = "old-password";
  get("new-password").value = "new-password";
  get("confirm-new-password").value = "mismatch";
  const passwordCalls = () => calls.filter((call) => call.url === "/api/auth/password").length;
  get("password-form").handlers.submit[0]({ preventDefault() {} });
  await flush();
  expect(passwordCalls()).toBe(0);
  expect(get("settings-status").textContent).toContain("不一致");
  get("confirm-new-password").value = "new-password";
  get("password-form").handlers.submit[0]({ preventDefault() {} });
  await flush();
  expect(passwordCalls()).toBe(1);
  expect(get("settings-status").textContent).toContain("密码已修改");
  expect(get("password-form").hidden).toBe(true);
  preferences.set("shelt-language", "en");
  storageChanged({ key: "shelt-language" });
  expect(get("settings-status").textContent).toContain("Password changed");
  expect(calls.filter(call => call.url === "/api/auth/password").length).toBe(1);

  get("settings-panel").handlers.keydown[0]({ key: "Escape" });
  expect(get("settings-panel").hidden).toBe(true);
});
