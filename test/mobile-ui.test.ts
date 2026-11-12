import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { NativeSnapshot } from "../src/mobile-model.ts";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["i18n", "mobile-model", "mobile-ui"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", "")).join("\n"),
);
function setup() {
  const nodes = new Map<string, any>(), writes: string[] = [], requests: string[] = [], focusRequests: string[] = [], zoomRequests: string[] = [];
  const create = () => ({ value: "", hidden: true, textContent: "", children: [] as any[], dataset: {} as Record<string, string>, attributes: {} as Record<string, string>, handlers: {} as Record<string, Function>, disabled: false, selectionStart: 0, selectionEnd: 0,
    addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }, append(...items: any[]) { this.children.push(...items); }, replaceChildren(...items: any[]) { this.children = items; }, setAttribute(k: string, v: string) { this.attributes[k] = v; }, querySelectorAll(selector: string) { return selector === "button" ? this.children : []; }, querySelector() { return this.children.find((b: any) => b.dataset.key === "Ctrl"); }, setPointerCapture() {}, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }, focus() {}, click() {} });
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, create()); return nodes.get(id); };
  let state: NativeSnapshot = {
    focused_pane_id: "p1",
    workspaces: [{ workspace_id: "w1", label: "工作区" }],
    tabs: [{ workspace_id: "w1", tab_id: "t9", label: "完整标签" }],
    agents: ["p1", "p2"].map((pane_id, index) => ({ pane_id, workspace_id: "w1", tab_id: "t9", name: `智能体${index + 1}`, agent: "qwen", agent_status: index ? "blocked" : "working" })),
  };
  let control: any, holdFocus = false, failFocus = false, finishFocus: (() => void) | undefined;
  let connections = 0, refreshes = 0;
  class Control {
    ready = false;
    constructor(private receive: (value: NativeSnapshot) => void) { control = this; }
    connect() { this.ready = true; connections++; this.receive(state); }
    close() { this.ready = false; }
    async refresh() { refreshes++; this.receive(state); }
    publish(value: NativeSnapshot) { state = value; this.receive(value); }
    async focus(pane: string) {
      focusRequests.push(pane);
      if (failFocus) throw new Error("native focus failed");
      if (holdFocus) await new Promise<void>(resolve => { finishFocus = resolve; });
      this.publish({ ...state, focused_pane_id: pane });
    }
    async zoom(pane: string) { zoomRequests.push(pane); }
  }
  const classes = new Set<string>();
  const context: any = {
    MobileControl: Control,
    document: { getElementById: get, createElement: create, addEventListener() {}, body: { classList: { contains: (s: string) => classes.has(s), toggle(s: string, on: boolean) { if (on) classes.add(s); else classes.delete(s); } } } },
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, dispatchEvent() {}, confirm: () => { throw new Error("Native dialogs must not be used"); } },
    Event: class {}, setTimeout, clearTimeout, localStorage: { getItem: () => "zh-CN" },
    fetch: async (url: string) => { requests.push(url); if (url !== "/api/herdr/targets") throw new Error(`Unexpected HTTP read ${url}`); return { ok: true, json: async () => ({ mode: "herdr", active: "local" }) }; },
  };
  runInNewContext(source + '\nglobalThis.ui = new MobileController({ write: v => { globalThis.writes.push(v); return true; }, focus() {}, async upload() {} });', Object.assign(context, { writes }));
  const ui = context.ui;
  const start = async () => { ui.setVisible(true); ui.connection(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { ui, get, writes, requests, focusRequests, zoomRequests, start, state: () => state, publish: (value: NativeSnapshot) => control.publish(value), connections: () => connections, refreshes: () => refreshes,
    holdFocus: () => { holdFocus = true; }, finishFocus: () => finishFocus!(), failFocus: () => { failFocus = true; } };
}

test("native snapshot is the source of focus; opening navigation sends no repeated requests", async () => {
  const env = setup(); await env.start();
  expect(env.ui.pane).toBe("p1"); expect(env.connections()).toBe(1); expect(env.requests).toEqual(["/api/herdr/targets"]);
  for (let i = 0; i < 4; i++) env.get("mobile-agents-toggle").handlers.click();
  expect(env.requests).toHaveLength(1); expect(env.refreshes()).toBe(0); expect(env.connections()).toBe(1);
  const oldDraft = env.get("mobile-draft"); oldDraft.value = "first draft";
  env.publish({ ...env.state(), focused_pane_id: "p2" });
  expect(env.ui.pane).toBe("p2"); expect(oldDraft.value).toBe("");
  oldDraft.value = "second draft"; env.publish({ ...env.state(), focused_pane_id: "p1" }); expect(oldDraft.value).toBe("first draft");
  expect(env.get("mobile-current").textContent).toBe("工作区 · 完整标签 · 智能体1");
});

test("agent cards show Herdr status dots on the left, without reordering", async () => {
  const env = setup(); await env.start();
  const list = env.get("mobile-agent-list");
  const card = list.children[0];
  expect(card.className).toContain("status-working");
  const head = card.children[0];
  expect(head.className).toBe("mobile-agent-head");
  expect(head.children[0].className).toBe("mobile-status-dot");
  expect(head.children[1].textContent).toContain("智能体1");
  expect(list.children[1].className).toContain("status-blocked");
});

test("mobile header returns to PC mode and restores the floating toggle", async () => {
  const env = setup(); await env.start();
  expect(env.get("mobile-toggle").hidden).toBe(true);
  expect(env.get("mobile-header").hidden).toBe(false);
  env.get("mobile-desktop").handlers.click();
  expect(env.ui.enabled).toBe(false);
  expect(env.get("mobile-header").hidden).toBe(true);
  expect(env.get("mobile-toggle").hidden).toBe(false);
});

test("click focuses Herdr without reconnecting or optimistically selecting; failed focus stays on old pane", async () => {
  const env = setup(); await env.start(); env.holdFocus();
  env.get("mobile-agents-toggle").handlers.click(); env.get("mobile-agent-list").children[1].handlers.click();
  expect(env.focusRequests).toEqual(["p2"]); expect(env.ui.pane).toBe("p1"); expect(env.connections()).toBe(1);
  expect(env.get("mobile-agents").hidden).toBe(true); expect(env.ui.input("not-while-changing")).toBe("");
  env.finishFocus(); await Promise.resolve(); await Promise.resolve();
  expect(env.ui.pane).toBe("p2"); expect(env.connections()).toBe(1);
  env.failFocus(); await env.ui.select({ paneId: "p1" }); expect(env.ui.pane).toBe("p2"); expect(env.get("mobile-status").textContent).not.toBe("");
  expect(env.requests).toEqual(["/api/herdr/targets"]);
});

test("native zoom is delegated and status changes never reorder agents", async () => {
  const env = setup(); await env.start();
  const before = env.get("mobile-agent-list").children.map((b: any) => b.children[0].textContent);
  env.publish({ ...env.state(), agents: env.state().agents.map(a => ({ ...a, agent_status: "done" })) });
  expect(env.get("mobile-agent-list").children.map((b: any) => b.children[0].textContent)).toEqual(before);
  env.get("mobile-zoom").handlers.click(); expect(env.zoomRequests).toEqual(["p1"]);
});

test("mobile composer respects IME and keeps failed or interrupted drafts", async () => {
  const env = setup(); await env.start(); const draft = env.get("mobile-draft"); draft.value = "中文草稿";
  draft.handlers.compositionstart(); await env.ui.submit(); expect(env.writes).toHaveLength(0);
  draft.handlers.compositionend(); await env.ui.submit(); expect(env.writes).toEqual(["\x1b[200~中文草稿\x1b[201~", "\r"]); expect(draft.value).toBe("");
  draft.value = "retain on focus change"; const pending = env.ui.submit(); env.publish({ ...env.state(), focused_pane_id: "p2" });
  await pending; expect(env.writes.at(-1)).not.toBe("\r");
  env.publish({ ...env.state(), focused_pane_id: "p1" }); expect(draft.value).toBe("retain on focus change");
  env.ui.connection(false); await env.ui.submit(); expect(draft.value).toBe("retain on focus change");
});

test("mobile key buttons prevent pointer focus loss, support Ctrl+Y and stop repeating", async () => {
  const env = setup(); await env.start();
  const button = (key: string) => env.get("mobile-keys").children.find((b: any) => b.dataset.key === key); let prevented = 0;
  button("Esc").handlers.pointerdown({ preventDefault: () => prevented++ }); button("Esc").handlers.mousedown({ preventDefault: () => prevented++ }); expect(prevented).toBe(2);
  button("Ctrl").handlers.click({ detail: 1 }); expect(env.ui.input("yes")).toBe(""); expect(env.writes.at(-1)).toBe("\x19"); expect(env.ui.input("c")).toBe("c");
  button("Ctrl+Y").handlers.click({ detail: 1 }); expect(env.writes.at(-1)).toBe("\x19");
  button("↑").handlers.pointerdown({ preventDefault() {}, pointerId: 1 }); expect(env.writes.at(-1)).toBe("\x1b[A"); expect(env.ui.repeat).toBeDefined();
  button("↑").handlers.pointercancel(); expect(env.ui.repeat).toBeUndefined();
  button("Ctrl").handlers.click({ detail: 1 }); expect(env.ui.input("中文")).toBe(""); expect(button("Ctrl").attributes["aria-pressed"]).toBe("true");
  env.ui.connection(false); expect(button("Ctrl").attributes["aria-pressed"]).toBe("false");
});

test("Ctrl in draft handles keyboard and mobile input without modifying the draft", async () => {
  const env = setup(); await env.start();
  const draft = env.get("mobile-draft"), ctrl = env.get("mobile-keys").children.find((b: any) => b.dataset.key === "Ctrl");
  draft.value = "keep draft"; draft.setSelectionRange(3, 6); let prevented = 0;
  ctrl.handlers.click({ detail: 1 }); draft.handlers.keydown({ key: "y", preventDefault() { prevented++; } });
  ctrl.handlers.click({ detail: 1 }); draft.handlers.beforeinput({ inputType: "insertText", data: "yes", cancelable: true, preventDefault() { prevented++; } });
  expect(env.writes).toEqual(["\x19", "\x19"]); expect(prevented).toBe(2); expect(draft.value).toBe("keep draft");
  ctrl.handlers.click({ detail: 1 }); draft.handlers.beforeinput({ inputType: "insertText", data: "a", cancelable: false });
  draft.value = "keeaa draft"; draft.handlers.input({ data: "a" }); expect(env.writes.at(-1)).toBe("\x01"); expect(draft.value).toBe("keep draft");
});

test("Ctrl IME commit restores draft and sends only once", async () => {
  const env = setup(); await env.start();
  const draft = env.get("mobile-draft"), ctrl = env.get("mobile-keys").children.find((b: any) => b.dataset.key === "Ctrl");
  draft.value = "draft"; draft.setSelectionRange(5, 5); ctrl.handlers.click({ detail: 1 });
  draft.handlers.compositionstart(); draft.value = "draftyes"; draft.handlers.input({ data: "yes", isComposing: true });
  expect(env.writes).toHaveLength(0); draft.handlers.compositionend({ data: "yes" }); draft.handlers.input({ data: "yes", isComposing: false });
  expect(draft.value).toBe("draft"); expect(env.writes).toEqual(["\x19"]);
  await new Promise(r => setTimeout(r, 0));
});
