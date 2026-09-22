import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/preview-preferences.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/html-preview.ts", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replace("export async function", "async function"),
);

function setup(preference: string | null = null) {
  const storage = new Map<string, string>();
  if (preference !== null) storage.set("shelt-html-interactive", preference);
  const mount: any = { children: [], textContent: "", replaceChildren(...children: unknown[]) { this.children = children; } };
  const handlers = new Map<string, (event: any) => void>();
  const calls: { url: string; method: string }[] = [];
  const spoken: any[][] = [];
  let sequence = 0;
  let complete: (() => void) | undefined;
  let defer = false;
  const context: any = {
    mount, localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    window: { addEventListener: (name: string, callback: (event: any) => void) => handlers.set(name, callback) },
    document: { createElement: () => ({ sandbox: { value: "" }, contentDocument: { title: "static" }, listeners: {} as Record<string, Function>, addEventListener(name: string, callback: Function) { this.listeners[name] = callback; } }) },
    tts: { setDocument: (...args: any[]) => spoken.push(args) },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method! });
      if (init.method === "DELETE") return { ok: true, status: 204 };
      const token = String(++sequence);
      if (defer) await new Promise<void>(resolve => { complete = resolve; });
      return { ok: true, json: async () => ({ token, url: `/api/preview-content/${token}/page.html` }) };
    },
  };
  runInNewContext(source, context);
  return {
    mount, calls, spoken, storage,
    start: () => context.mountHtmlPreview(mount, "/page.html", "/api/preview?path=%2Fpage.html", context.tts),
    event: (name: string, event: unknown = {}) => handlers.get(name)?.(event),
    change: (value: string) => { storage.set("shelt-html-interactive", value); handlers.get("storage")?.({ key: "shelt-html-interactive" }); },
    defer: () => { defer = true; }, complete: () => complete!(),
  };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("HTML preview defaults to isolated scripts and revokes its address when switching to static", async () => {
  const ui = setup();
  await ui.start();
  expect(ui.mount.children[0].sandbox.value).toBe("allow-scripts");
  expect(ui.mount.children[0].src).toBe("/api/preview-content/1/page.html");
  expect(ui.spoken.at(-1)?.[0]).toBeNull();
  expect(ui.spoken.at(-1)?.[2]).toContain("交互模式");
  ui.change("false");
  await flush();
  expect(ui.calls).toContainEqual({ url: "/api/preview-session/1", method: "DELETE" });
  const frame = ui.mount.children[0];
  expect(frame.sandbox.value).toBe("allow-same-origin");
  expect(frame.src).toBe("/api/preview?path=%2Fpage.html");
  frame.listeners.load();
  expect(ui.spoken.at(-1)?.[0]).toBe(frame.contentDocument);
  ui.change("true");
  await flush();
  expect(ui.mount.children[0].sandbox.value).toBe("allow-scripts");
  ui.event("pagehide");
  expect(ui.calls).toContainEqual({ url: "/api/preview-session/2", method: "DELETE" });
});

test("HTML preview remembers static mode without creating a resource grant", async () => {
  const ui = setup("false");
  await ui.start();
  expect(ui.calls).toEqual([]);
  expect(ui.mount.children[0].sandbox.value).toBe("allow-same-origin");
});

test("a late interactive response cannot replace the newly selected static mode", async () => {
  const ui = setup();
  ui.defer();
  const pending = ui.start();
  ui.change("false");
  await flush();
  expect(ui.mount.children[0].sandbox.value).toBe("allow-same-origin");
  ui.complete();
  await pending;
  expect(ui.mount.children[0].sandbox.value).toBe("allow-same-origin");
  expect(ui.calls).toContainEqual({ url: "/api/preview-session/1", method: "DELETE" });
});
