import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/update-ui.ts", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "")
    .replace("export function setupUpdates", "function setupUpdates"),
);

type Status = { currentVersion: string; latestVersion: string | null; available: boolean; canInstall: boolean; reason: string | null; phase: string; error: string | null };

const status = (overrides: Partial<Status> = {}): Status => ({
  currentVersion: "v0.0.21", latestVersion: null, available: false, canInstall: true, reason: null, phase: "idle", error: null, ...overrides,
});

function fakeElement(): any {
  const element: any = {
    hidden: false,
    disabled: false,
    textContent: "",
    attributes: {} as Record<string, string>,
    handlers: {} as Record<string, Function[]>,
    addEventListener(name: string, handler: Function) { (this.handlers[name] ??= []).push(handler); },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
  };
  return element;
}

const settle = async (times = 10) => {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function boot(initial: Status) {
  const elements: Record<string, any> = {
    "update-install": fakeElement(),
    "update-dot": fakeElement(),
    "update-status": fakeElement(),
    "settings-toggle": fakeElement(),
  };
  const calls: { url: string; method: string }[] = [];
  const timers: (() => void)[] = [];
  const observers: (() => void)[] = [];
  const visibilityHandlers: (() => void)[] = [];
  const state = { body: initial, get: 200, post: undefined as { ok: boolean; status: number; body: any } | undefined, confirm: true, reloads: 0, confirmations: 0 };
  const clock = { value: 1_000_000 };
  const sandbox: any = {
    localStorage: { getItem: () => null, setItem: () => {} },
    Date: { now: () => clock.value },
    document: {
      hidden: false,
      documentElement: { lang: "" },
      querySelectorAll: () => [],
      getElementById: (id: string) => elements[id] ?? null,
      addEventListener: (_name: string, handler: () => void) => visibilityHandlers.push(handler),
    },
    MutationObserver: class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
    },
    setInterval: () => 0,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    AbortSignal: { timeout: () => undefined },
    location: { reload: () => { state.reloads += 1; } },
    confirm: () => { state.confirmations += 1; return state.confirm; },
    fetch: async (url: string, init: any = {}) => {
      const method = init.method || "GET";
      calls.push({ url, method });
      if (url !== "/api/update") throw new Error(`Unexpected request ${method} ${url}`);
      if (method === "GET") {
        const body = state.body;
        const code = state.get;
        return { ok: code === 200, status: code, json: async () => body };
      }
      const post = state.post ?? { ok: true, status: 202, body: { ok: true } };
      return { ok: post.ok, status: post.status, json: async () => post.body };
    },
  };
  runInNewContext(
    `${source}\nconst updates = setupUpdates();\nglobalThis.__check = updates.check;\nglobalThis.__active = updates.active;\nglobalThis.__setLanguage = setLanguage;`,
    sandbox,
  );
  return {
    elements,
    calls,
    clock,
    observers,
    visibilityHandlers,
    document: sandbox.document,
    setBody: (body: Status) => { state.body = body; },
    setStatus: (code: number) => { state.get = code; },
    setPost: (result: { ok: boolean; status: number; body: any }) => { state.post = result; },
    setConfirm: (value: boolean) => { state.confirm = value; },
    confirmations: () => state.confirmations,
    reloads: () => state.reloads,
    check: () => sandbox.__check() as Promise<void>,
    active: () => sandbox.__active() as boolean,
    language: (value: "en" | "zh-CN") => sandbox.__setLanguage(value),
    runTimer: async () => { timers.shift()?.(); await settle(); },
  };
}

test("update UI renders availability, button labels and settings badge", async () => {
  const fixture = boot(status());
  await settle();
  expect(fixture.calls).toEqual([{ url: "/api/update", method: "GET" }]);
  expect(fixture.elements["update-dot"].hidden).toBe(true);
  expect(fixture.elements["update-install"].hidden).toBe(true);
  expect(fixture.elements["update-status"].textContent).toBe("");
  expect(fixture.elements["settings-toggle"].attributes["aria-label"]).toBe("设置");

  fixture.setBody(status({ latestVersion: "v0.0.22", available: true }));
  fixture.clock.value += 3_600_001;
  await fixture.check();
  const button = fixture.elements["update-install"];
  expect(fixture.elements["update-dot"].hidden).toBe(false);
  expect(button.hidden).toBe(false);
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe("升级 v0.0.22");
  expect(fixture.elements["update-status"].textContent).toBe("发现新版本 v0.0.22");
  expect(fixture.elements["settings-toggle"].attributes["aria-label"]).toBe("设置 · 发现新版本 v0.0.22");
});

test("update UI explains blocked installs and surfaces check errors", async () => {
  const fixture = boot(status({ latestVersion: "v0.0.22", available: true, canInstall: false, reason: "updateDevelopment" }));
  await settle();
  const button = fixture.elements["update-install"];
  expect(button.hidden).toBe(false);
  expect(button.disabled).toBe(true);
  expect(fixture.elements["update-status"].textContent).toBe("开发构建不自动覆盖，请先安装正式 Release。");

  fixture.setBody(status({ error: "updateRateLimited" }));
  fixture.clock.value += 3_600_001;
  await fixture.check();
  expect(fixture.elements["update-status"].textContent).toBe("GitHub 请求限流，稍后会重试。");
});

test("update UI follows language switches", async () => {
  const fixture = boot(status({ latestVersion: "v0.0.22", available: true }));
  await settle();
  fixture.language("en");
  expect(fixture.elements["update-install"].textContent).toBe("Upgrade v0.0.22");
  expect(fixture.elements["update-status"].textContent).toBe("New version v0.0.22 available");
  expect(fixture.elements["settings-toggle"].attributes["aria-label"]).toBe("Settings · New version v0.0.22 available");
  fixture.language("zh-CN");
  expect(fixture.elements["update-install"].textContent).toBe("升级 v0.0.22");
});

test("install click requires confirmation, posts once and tracks phases", async () => {
  const fixture = boot(status({ latestVersion: "v0.0.22", available: true }));
  await settle();
  const button = fixture.elements["update-install"];
  const statusText = () => fixture.elements["update-status"].textContent;

  fixture.setConfirm(false);
  button.handlers.click[0]();
  await settle();
  expect(fixture.confirmations()).toBe(1);
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(0);

  fixture.setConfirm(true);
  button.handlers.click[0]();
  await settle();
  expect(fixture.calls.at(-1)).toEqual({ url: "/api/update", method: "POST" });
  expect(fixture.active()).toBe(true);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("升级中…");
  expect(statusText()).toBe("正在下载官方版本…");

  fixture.setBody(status({ latestVersion: "v0.0.22", available: true, phase: "downloading" }));
  await fixture.runTimer();
  expect(statusText()).toBe("正在下载官方版本…");
  expect(fixture.active()).toBe(true);

  fixture.setBody(status({ latestVersion: "v0.0.22", available: true, phase: "verifying" }));
  await fixture.runTimer();
  expect(statusText()).toBe("正在校验版本和 SHA-256…");

  fixture.setBody(status({ latestVersion: "v0.0.22", available: true, phase: "restarting" }));
  await fixture.runTimer();
  expect(statusText()).toBe("正在重启，即将刷新页面…");

  fixture.setBody(status({ currentVersion: "v0.0.22" }));
  await fixture.runTimer();
  expect(fixture.active()).toBe(false);
  expect(statusText()).toBe("");
  expect(fixture.elements["update-dot"].hidden).toBe(true);
  expect(fixture.elements["update-install"].hidden).toBe(true);
  expect(fixture.elements["settings-toggle"].attributes["aria-label"]).toBe("设置");
});

test("failed install reports a localized error and clears installing state", async () => {
  const fixture = boot(status({ latestVersion: "v0.0.22", available: true }));
  await settle();
  fixture.setPost({ ok: false, status: 409, body: { error: "updateBusy" } });
  fixture.elements["update-install"].handlers.click[0]();
  await settle();
  expect(fixture.active()).toBe(false);
  expect(fixture.elements["update-status"].textContent).toBe("此安装正在升级，请稍候。");
  expect(fixture.elements["update-install"].disabled).toBe(false);
});

test("install reloads on auth loss and checks resume with the settings panel", async () => {
  const fixture = boot(status({ latestVersion: "v0.0.22", available: true }));
  await settle();
  fixture.elements["update-install"].handlers.click[0]();
  await settle();
  fixture.setStatus(401);
  await fixture.runTimer();
  expect(fixture.reloads()).toBe(1);

  const other = boot(status());
  await settle();
  const gets = () => other.calls.filter((call) => call.method === "GET").length;
  const count = gets();
  other.document.hidden = true;
  other.clock.value += 3_600_001;
  await other.check();
  expect(gets()).toBe(count);
  other.visibilityHandlers[0]();
  await settle();
  expect(gets()).toBe(count);
  other.document.hidden = false;
  other.visibilityHandlers[0]();
  await settle();
  expect(gets()).toBe(count + 1);

  other.elements["settings-toggle"].hidden = true;
  other.clock.value += 3_600_001;
  other.observers[0]();
  await settle();
  expect(gets()).toBe(count + 1);
  other.elements["settings-toggle"].hidden = false;
  other.observers[0]();
  await settle();
  expect(gets()).toBe(count + 2);
});
