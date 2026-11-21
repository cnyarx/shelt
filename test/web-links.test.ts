import { expect, test } from "bun:test";
import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createWebLinkProvider, findUrls } from "../src/web-links.ts";
import { documentPathAtMouse } from "../src/document-links.ts";

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
    rows: rows.length,
    buffer: { active: { viewportY: 0, length: lines.length, getLine: (index: number) => lines[index] } },
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

test("a parenthesized URL ends at its own closing delimiter, not at the next space", () => {
  const review = "https://example.org/reviews/12345678";
  const nested = "https://example.org/中文/(a_(b))?q=(c)#(d)";
  const fullWidth = "https://example.org/资料（甲（乙））";
  for (const [url, line] of [
    [review, `1. 本轮没有新的编排结果。 17:06 核实，编排修复单 (${review})仍在第二轮 AI 评审。`],
    [nested, `参考 ( ${nested})仍在评审。`],
    [fullWidth, `评审单（${fullWidth}）已回复。`],
  ] as const) {
    const start = line.indexOf(url);
    expect(findUrls(line)).toEqual([{ url, start, end: start + url.length }]);
  }
  const next = "http://example.org/%28file%29";
  expect(findUrls(`(${review})见（${next}）结束`).map(link => link.url)).toEqual([review, next]);
  expect(findUrls("https://example.org/a)b?q=1")[0]?.url).toBe("https://example.org/a)b?q=1");
});

test("a Markdown destination ends before adjacent prose and the next link", () => {
  const url = "https://example.org/projects/123/workitems/456";
  const prefix = "2.2 请权限管理员在[镜像工作项](";
  const line = `${prefix}${url})回复：  `;
  expect(findUrls(line)).toEqual([{ url, start: prefix.length, end: prefix.length + url.length }]);
  const nested = "https://example.com/中文/(a_(b))?q=(c)#(d)";
  const next = "http://example.org/%28id%29";
  for (const text of [`[一](${nested})[二](${next})。`, `[一]( ${nested} "标题")，再看[二](${next})`]) {
    expect(findUrls(text)).toEqual([nested, next].map(url => ({ url, start: text.indexOf(url), end: text.indexOf(url) + url.length })));
  }
});

test.each(["[item](", "item (", "("])("a wrapped link after %s uses the same exact destination for underline, hover and click", async prefix => {
  const url = "https://example.com/items/12345678";
  const text = `${prefix}${url})仍在第二轮 AI 评审。`;
  const cols = 25;
  const terminal = makeTerminal([text.slice(0, cols), text.slice(cols)], 1, cols);
  const mount = makeMount(), opened: string[] = [];
  const provider = createWebLinkProvider(terminal, mount, value => opened.push(value));
  for (const row of [1, 2]) {
    const [link] = await provideLinks(provider, row);
    expect(link!.range).toEqual({ start: { x: prefix.length + 1, y: 1 }, end: { x: prefix.length + url.length - cols, y: 2 } });
    link!.hover?.(undefined as never, link!.text);
    expect(mount.title).toBe(url);
    link!.activate(undefined as never, link!.text);
  }
  expect(opened).toEqual([url, url]);
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

test.each(["7. 新增文档 (", "[新增文档](", "新增文档（"])('reconstructs an explicitly broken document URL after %s, even when its tail is hovered first', async prefix => {
  const head = "https://example.org/repo/blob/revision/sql-engine/vector-dedup-staged-fu";
  const tail = "nctions.md#L48", close = prefix.endsWith("（") ? "）" : ")";
  const terminal = makeTerminal([`${prefix}${head}`.padEnd(100), `  ${tail}${close} 更新前搜不到，更新后能搜到。`, "8. 以后源文档有改动，还没测。"], 99, 100);
  const mount = makeMount(), opened: string[] = [];
  const provider = createWebLinkProvider(terminal, mount, url => opened.push(url));
  for (const [line, start, end] of [[2, 3, 2 + tail.length], [1, prefix.length + 1, prefix.length + head.length]]) {
    const links = await provideLinks(provider, line);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.range).toEqual({ start: { x: start, y: line }, end: { x: end, y: line } });
    link.hover?.(undefined as never, link.text);
    expect(mount.title).toBe(head + tail);
    link.activate(undefined as never, link.text);
  }
  expect(opened).toEqual([head + tail, head + tail]);
  expect(await provideLinks(provider, 3)).toEqual([]);
});

test("a continuation that resembles a document path does not open a local preview", async () => {
  const terminal = makeTerminal(["see (https://example.org/docs/", "sql-engine/functions.md#L48) ./local.md"], 99);
  const web = createWebLinkProvider(terminal, makeMount(), () => undefined);
  const screen = { left: 0, top: 0, right: 480, bottom: 20, width: 480, height: 20 };
  const localAt = (column: number) => documentPathAtMouse(terminal, screen, column * 10 - 5, 15, web.containsCell);
  expect((await provideLinks(web, 2))[0]?.text).toBe("https://example.org/docs/sql-engine/functions.md#L48");
  expect(localAt(1)).toBeNull();
  expect(localAt(8)).toBeNull();
  expect(localAt(34)).toBe("./local.md");
});

test("keeps nested parentheses and all three pieces of a URL across hard breaks", async () => {
  const parts = ["https://example.org/docs/(v", "2)/dir/", "file.md?q=x%20y#L48"];
  const terminal = makeTerminal([`see (${parts[0]}`, parts[1]!, `${parts[2]}) next`], 99);
  const provider = createWebLinkProvider(terminal, makeMount(), () => undefined);
  for (const row of [3, 2, 1]) expect((await provideLinks(provider, row)).map(l => l.text)).toEqual([parts.join("")]);
});

test.each([
  ["(https://example.org/doc", "8. more text)"],
  ["(https://example.org/doc", "this is unrelated prose)"],
  ["(https://example.org/doc", "file.md", "", "later)"],
  ["(https://example.org/doc", "https://elsewhere.test/end)"],
  ["https://example.org/doc", "more.md)"],
  ["(https://example.org", ".other.test/path)"],
].map(rows => ({ rows })))("does not glue unrelated lines or extend an authority: %j", async ({ rows }) => {
  const provider = createWebLinkProvider(makeTerminal(rows, 99), makeMount(), () => undefined);
  for (let row = 1; row <= rows.length; row++) {
    expect((await provideLinks(provider, row)).map(l => l.text)).toEqual(findUrls(rows[row - 1]!).map(m => m.url));
  }
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
