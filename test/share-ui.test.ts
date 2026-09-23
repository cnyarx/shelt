import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/share-ui.ts", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replace("export function", "function"),
);

test("share controls serialize requests and preserve regeneration confirmation", async () => {
  const elements = new Map<string, any>();
  for (const id of ["share-toolbar", "share-toggle", "share-panel", "share-status", "share-create", "share-revoke", "share-url", "tts-toolbar"]) {
    elements.set(id, { hidden: id === "share-panel", style: {}, handlers: {}, addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }, setAttribute() {}, classList: { contains: () => true } });
  }
  let complete: (value: unknown) => void = () => {};
  const requests: string[] = [];
  let confirmed = false;
  runInNewContext(`${source}\nsetupShare('/doc.md');`, {
    document: { getElementById: (id: string) => elements.get(id) },
    ResizeObserver: class { observe() {} },
    fetch: (_url: string, options: { method: string }) => {
      requests.push(options.method);
      return new Promise(resolve => { complete = value => resolve({ ok: true, json: async () => value }); });
    },
    confirm: () => { confirmed = true; return false; },
  });
  const get = (id: string) => elements.get(`share-${id}`);
  const loading = get("toggle").handlers.click();
  expect(get("create").disabled).toBe(true);
  expect(get("revoke").disabled).toBe(true);
  await get("create").handlers.click();
  expect(requests).toEqual(["GET"]);
  complete({ expiresAt: 2000000000 });
  await loading;
  await get("create").handlers.click();
  expect(confirmed).toBe(true);
  expect(requests).toEqual(["GET"]);
  const revoking = get("revoke").handlers.click();
  await get("create").handlers.click();
  expect(requests).toEqual(["GET", "DELETE"]);
  expect(get("create").disabled).toBe(true);
  complete({ ok: true });
  await revoking;
  expect(get("revoke").disabled).toBe(true);
  expect(get("create").disabled).toBe(false);
  expect(get("status").textContent).toContain("已撤销");
});

for (const valid of [true, false]) {
  test(`cached link with unchanged expiry is ${valid ? "kept when valid" : "discarded after same-second rotation"}`, async () => {
    const elements = new Map<string, any>();
    for (const id of ["share-toolbar", "share-toggle", "share-panel", "share-status", "share-create", "share-revoke", "share-url", "tts-toolbar"]) {
      elements.set(id, { hidden: id === "share-panel", style: {}, handlers: {}, addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }, setAttribute() {}, classList: { contains: () => true } });
    }
    const key = "a".repeat(64);
    const expiry = 2000000000;
    const requests: string[] = [];
    const copies: string[] = [];
    let created = false;
    let confirmations = 0;
    runInNewContext(`${source}\nsetupShare('/doc.md');`, {
      document: { getElementById: (id: string) => elements.get(id) },
      ResizeObserver: class { observe() {} },
      URL, location: { origin: "https://shelt.example" },
      navigator: { clipboard: { writeText: async (value: string) => { copies.push(value); } } },
      fetch: async (url: string, options: { method: string }) => {
        requests.push(options.method);
        if (options.method === "HEAD") {
          expect(url).toBe(`/api/share/${key}`);
          return { ok: valid };
        }
        if (options.method === "POST") created = true;
        return { ok: true, json: async () => ({ expiresAt: created ? expiry : null, url: `/share/${key}` }) };
      },
      confirm: () => { confirmations += 1; return false; },
    });
    const get = (id: string) => elements.get(`share-${id}`);
    await get("toggle").handlers.click();
    await get("create").handlers.click();
    expect(copies).toEqual([`https://shelt.example/share/${key}`]);
    await get("toggle").handlers.click();
    await get("toggle").handlers.click();
    expect(requests).toEqual(["GET", "POST", "GET", "HEAD"]);
    expect(get("url").hidden).toBe(!valid);
    expect(get("create").textContent).toBe(valid ? "复制分享链接" : "重新生成并复制");
    await get("create").handlers.click();
    expect(confirmations).toBe(valid ? 0 : 1);
    expect(copies.length).toBe(valid ? 2 : 1);
    expect(requests).toEqual(["GET", "POST", "GET", "HEAD"]);
  });
}

test("switching share language preserves the link, selection and last feedback without requests", async () => {
  const elements = new Map<string, any>();
  for (const id of ["share-toolbar", "share-toggle", "share-panel", "share-status", "share-create", "share-revoke", "share-url", "tts-toolbar"]) {
    elements.set(id, { hidden: id === "share-panel", style: {}, handlers: {}, selectionStart: 0, selectionEnd: 0, addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }, setAttribute() {}, classList: { contains: () => true } });
  }
  const requests: string[] = [];
  const context: any = {
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: (id: string) => elements.get(id) },
    ResizeObserver: class { observe() {} }, URL, location: { origin: "https://shelt.example" },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (_url: string, options: { method: string }) => { requests.push(options.method); return { ok: true, json: async () => ({ expiresAt: options.method === "GET" ? null : 2000000000, url: `/share/${"a".repeat(64)}` }) }; },
  };
  runInNewContext(`${source}\nsetupShare('/doc.md');`, context);
  const get = (id: string) => elements.get(`share-${id}`);
  await get("toggle").handlers.click();
  await get("create").handlers.click();
  get("url").selectionStart = 5;
  get("url").selectionEnd = 10;
  const link = get("url").value;
  context.setLanguage("en");
  expect(get("create").textContent).toBe("Copy share link");
  expect(get("status").textContent).toContain("Link copied");
  expect(get("url").value).toBe(link);
  expect(get("url").selectionStart).toBe(5);
  expect(get("url").selectionEnd).toBe(10);
  expect(get("panel").hidden).toBe(false);
  expect(requests).toEqual(["GET", "POST"]);
});
