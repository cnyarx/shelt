import { expect, test } from "bun:test";
import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createWebLinkProvider, findUrls } from "../src/web-links.ts";

function provideLinks(provider: ILinkProvider, line: number) {
  return new Promise<NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>>((resolve) => {
    provider.provideLinks(line, (provided) => resolve(provided ?? []));
  });
}

function makeTerminal(rows: string[], wrappedFrom: number, cols = 48): Terminal {
  const lines = rows.map((text, index) => ({
    isWrapped: index >= wrappedFrom,
    length: text.length,
    getCell: (cell: number) => ({ getWidth: () => 1, getChars: () => text[cell] || " " }),
  }));
  return {
    cols,
    buffer: { active: { length: lines.length, getLine: (index: number) => lines[index] } },
    onWriteParsed: () => ({ dispose: () => undefined }),
    onResize: () => ({ dispose: () => undefined }),
  } as unknown as Terminal;
}

function makeMount() {
  return {
    title: "",
    removeAttribute: () => undefined,
    classList: { add: () => undefined, remove: () => undefined },
  } as unknown as HTMLElement;
}

test("findUrls matches plain http and https links", () => {
  expect(findUrls("see https://example.com/page and http://a.b/c?d=1#e")).toEqual([
    { url: "https://example.com/page", start: 4, end: 28 },
    { url: "http://a.b/c?d=1#e", start: 33, end: 51 },
  ]);
});

test("findUrls trims trailing punctuation but keeps inner slashes", () => {
  expect(findUrls("go to https://example.com/docs/intro.")[0]?.url).toBe("https://example.com/docs/intro");
  expect(findUrls("(https://example.com/x),")[0]?.url).toBe("https://example.com/x");
  expect(findUrls("链接：https://example.com/中文页。")[0]?.url).toBe("https://example.com/中文页");
  expect(findUrls("https://example.com/a/b/c) and more text")).toEqual([
    { url: "https://example.com/a/b/c", start: 0, end: 25 },
  ]);
});

test("findUrls ignores non-URL text and bare protocols", () => {
  expect(findUrls("no links here")).toEqual([]);
  expect(findUrls("file:///tmp/report.md")).toEqual([]);
  expect(findUrls("path /home/user/readme.md only")).toEqual([]);
});

test("opens the full URL when it wraps across narrow terminal rows", async () => {
  const url = "https://github.com/cnyarx/shelt/releases/download/v0.0.24/shelt-x86";
  const split = 40;
  const terminal = makeTerminal([url.slice(0, split), url.slice(split)], 1, 40);
  const opened: string[] = [];
  const provider = createWebLinkProvider(terminal, makeMount(), (url) => opened.push(url));

  for (const row of [1, 2]) {
    const links = await provideLinks(provider, row);
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe(url);
    links[0]?.activate(undefined as never, undefined as never);
    expect(opened).toEqual([url]);
    opened.length = 0;
  }
});

test("joins a URL spread over three wrapped rows", async () => {
  const url = "https://yuque.alibaba-inc.com/maxcompute/bx26tp/odps_sql_tips_and_best_practices";
  const rows = [url.slice(0, 30), url.slice(30, 60), url.slice(60)];
  const terminal = makeTerminal(rows, 1);
  const links = await provideLinks(createWebLinkProvider(terminal, makeMount(), () => undefined), 3);
  expect(links).toHaveLength(1);
  expect(links[0]?.text).toBe(url);
  expect(links[0]?.range).toEqual({
    start: { x: 1, y: 1 },
    end: { x: rows[2]!.length, y: 3 },
  });
});

test("does not join URLs across separate non-wrapped lines", async () => {
  const terminal = makeTerminal(["check https://example.com/a", "also https://example.com/b"], 99);
  const provider = createWebLinkProvider(terminal, makeMount(), () => undefined);
  expect((await provideLinks(provider, 1)).map((link) => link.text)).toEqual(["https://example.com/a"]);
  expect((await provideLinks(provider, 2)).map((link) => link.text)).toEqual(["https://example.com/b"]);
});

test("wraps the trailing punctuation trim into the clickable range", async () => {
  const url = "https://example.com/very/long/path/that/wraps/at/point";
  const split = 40;
  const terminal = makeTerminal([url.slice(0, split), `${url.slice(split)}.`], 1, 40);
  const links = await provideLinks(createWebLinkProvider(terminal, makeMount(), () => undefined), 1);
  expect(links).toHaveLength(1);
  expect(links[0]?.text).toBe(url);
});

test("keeps document paths out of web links and shows hover title", async () => {
  const line = "preview /tmp/report.md at https://example.com/view now";
  const terminal = makeTerminal([line], 99, 64);
  const mount = makeMount();
  const provider = createWebLinkProvider(terminal, mount, () => undefined);
  const links = await provideLinks(provider, 1);
  expect(links.map((link) => link.text)).toEqual(["https://example.com/view"]);
  links[0]?.hover?.(undefined as never, links[0]!.text);
  expect(mount.title).toBe("https://example.com/view");
  links[0]?.leave?.(undefined as never, links[0]!.text);
  expect(mount.removeAttribute).toBeTruthy();
});
