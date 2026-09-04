import { describe, expect, test } from "bun:test";
import type { ILinkProvider, Terminal } from "@xterm/xterm";
import {
  createDocumentLinkProvider,
  documentPathAtMouse,
  findDocumentPaths,
  previewUrl,
  registerDocumentLinkMouseActivation,
} from "../src/document-links.ts";

function provideLinks(provider: ILinkProvider, line: number) {
  return new Promise<NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>>((resolve) => {
    provider.provideLinks(line, (provided) => resolve(provided ?? []));
  });
}

describe("terminal document links", () => {
  test("finds every supported document and image extension", () => {
    for (const extension of ["md", "markdown", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp"]) {
      const path = `/home/user/docs/example.${extension}`;
      expect(findDocumentPaths(`open ${path} now`)).toEqual([
        { path, start: 5, end: 5 + path.length },
      ]);
    }
  });

  test("finds supported absolute paths and removes line locations", () => {
    expect(findDocumentPaths("open /home/user/docs/readme.md:12:3 now")).toEqual([
      { path: "/home/user/docs/readme.md", start: 5, end: 30 },
    ]);
    expect(findDocumentPaths("see /tmp/diagram.SVG#L8C2")[0]?.path).toBe("/tmp/diagram.SVG");
  });

  test("supports quoted, escaped-space, unquoted Agent output, and Unicode paths", () => {
    expect(findDocumentPaths("'/home/user/设计 文档/架构.md'")[0]).toEqual({
      path: "/home/user/设计 文档/架构.md",
      start: 1,
      end: 23,
    });
    expect(findDocumentPaths(String.raw`/home/user/design\ notes/diagram.png`)[0]?.path).toBe(
      "/home/user/design notes/diagram.png",
    );
    expect(findDocumentPaths("`/tmp/my page.html`")[0]?.path).toBe("/tmp/my page.html");
    expect(findDocumentPaths("主文档：/home/admin/github/cnyarx/xian/整理这多天期望的哲思归类.md")[0]?.path).toBe(
      "/home/admin/github/cnyarx/xian/整理这多天期望的哲思归类.md",
    );
    expect(findDocumentPaths("交接记录：/home/admin/github/cnyarx/xian/handoffs/HANDOFF_ONTOLOGY_LEARNING.md")[0]?.path).toBe(
      "/home/admin/github/cnyarx/xian/handoffs/HANDOFF_ONTOLOGY_LEARNING.md",
    );
  });

  test("finds relative paths while rejecting unsupported paths and URLs", () => {
    expect(findDocumentPaths(
      "handoffs/HANDOFF_M4_MACOS_RELEASE.md handoffs/HANDOFF_DocumentLinks.md",
    )).toEqual([
      { path: "handoffs/HANDOFF_M4_MACOS_RELEASE.md", start: 0, end: 36 },
      { path: "handoffs/HANDOFF_DocumentLinks.md", start: 37, end: 70 },
    ]);
    expect(findDocumentPaths("│handoffs/HANDOFF_DocumentLinks.md")).toEqual([
      { path: "handoffs/HANDOFF_DocumentLinks.md", start: 1, end: 34 },
    ]);
    expect(findDocumentPaths("./docs/readme.md ../images/diagram.png").map(({ path }) => path)).toEqual([
      "./docs/readme.md",
      "../images/diagram.png",
    ]);
    expect(findDocumentPaths("docs/readme.md /tmp/report.pdf /tmp/script.js https://example.com/page.html")).toEqual([
      { path: "docs/readme.md", start: 0, end: 14 },
    ]);
    expect(findDocumentPaths("http://localhost:6080/vnc.html")).toEqual([]);
    expect(findDocumentPaths("open 6080/vnc.html")).toEqual([
      { path: "6080/vnc.html", start: 5, end: 18 },
    ]);
  });

  test("provides links when xterm marks the physical row as wrapped", async () => {
    const text = "主文档：/home/admin/github/cnyarx/xian/整理这多天期望的哲思归类.md";
    const cells = [...text].map((character) => ({
      getWidth: () => 1,
      getChars: () => character,
    }));
    const line = {
      isWrapped: true,
      length: cells.length,
      getCell: (index: number) => cells[index],
    };
    const terminal = {
      buffer: { active: { getLine: () => line } },
    } as unknown as Terminal;
    const mount = {
      title: "",
      removeAttribute: () => undefined,
    } as unknown as HTMLElement;
    const provider = createDocumentLinkProvider(terminal, mount, () => undefined);
    const links = await provideLinks(provider, 1);
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe("/home/admin/github/cnyarx/xian/整理这多天期望的哲思归类.md");
  });

  test("joins paths across wrapped physical rows", async () => {
    const path = "/home/admin/github/cnyarx/xian/为什么标准超弦理论要求十维.md";
    const split = 34;
    const firstText = path.slice(0, split);
    const secondText = path.slice(split);
    const makeLine = (text: string, isWrapped: boolean) => ({
      isWrapped,
      length: text.length,
      getCell: (index: number) => ({ getWidth: () => 1, getChars: () => text[index] || " " }),
    });
    const lines = [makeLine(firstText, false), makeLine(secondText, true)];
    const terminal = {
      cols: 40,
      buffer: { active: { length: lines.length, getLine: (index: number) => lines[index] } },
    } as unknown as Terminal;
    const links = await provideLinks(createDocumentLinkProvider(terminal, {} as HTMLElement, () => undefined), 2);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      text: path,
      range: { start: { x: 1, y: 1 }, end: { x: secondText.length, y: 2 } },
    });
  });
  test("maps double-width xterm cells to the provider link range", async () => {
    const prefix = "文档路径：";
    const path = "/home/admin/github/cnyarx/xian/弦理论与大模型训练的已知关系.md";
    const cells: Array<{ getWidth: () => number; getChars: () => string }> = [];
    for (const character of [...`${prefix}${path}`]) {
      const width = /[\u3000-\u9fff\uff01-\uff60]/u.test(character) ? 2 : 1;
      cells.push({ getWidth: () => width, getChars: () => character });
      if (width === 2) cells.push({ getWidth: () => 0, getChars: () => "" });
    }
    const terminal = {
      cols: cells.length,
      buffer: { active: { length: 1, getLine: () => ({ length: cells.length, isWrapped: false, getCell: (index: number) => cells[index] }) } },
    } as unknown as Terminal;
    const mount = {
      title: "",
      removeAttribute: () => undefined,
    } as unknown as HTMLElement;
    const links = await provideLinks(createDocumentLinkProvider(terminal, mount, () => undefined), 1);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      text: path,
      range: {
        start: { x: prefix.length * 2 + 1, y: 1 },
        end: { x: cells.length, y: 1 },
      },
    });
  });

  test("uses the overlay as the only underline and keeps hover cursor state", async () => {
    const path = "/home/user/docs/readme.md";
    const cells = [...path].map((character) => ({ getWidth: () => 1, getChars: () => character }));
    const classes = new Set<string>();
    const terminal = {
      buffer: { active: { getLine: () => ({ length: cells.length, getCell: (index: number) => cells[index] }) } },
    } as unknown as Terminal;
    const mount = {
      title: "",
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
      removeAttribute: () => undefined,
    } as unknown as HTMLElement;
    const links = await provideLinks(createDocumentLinkProvider(terminal, mount, () => undefined), 1);
    expect(links[0]?.decorations).toEqual({ underline: false, pointerCursor: true });
    links[0]?.hover?.({} as MouseEvent, path);
    expect(mount.title).toBe(path);
    expect(classes.has("document-link-hover")).toBeTrue();
    links[0]?.leave?.({} as MouseEvent, path);
    expect(classes.has("document-link-hover")).toBeFalse();
  });

  test("maps a mouse position to a document path", () => {
    const path = "/home/admin/github/cnyarx/xian/弦理论与大模型训练的已知关系.md";
    const cells = [...path].map((character) => ({ getWidth: () => 1, getChars: () => character }));
    const terminal = {
      cols: 100,
      rows: 10,
      buffer: {
        active: {
          viewportY: 5,
          getLine: (index: number) => index === 5
            ? { length: cells.length, getCell: (cell: number) => cells[cell] }
            : undefined,
        },
      },
    } as unknown as Terminal;
    const screen = { left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100 };
    expect(documentPathAtMouse(terminal, screen, 5, 5)).toBe(path);
    expect(documentPathAtMouse(terminal, screen, 995, 5)).toBeNull();
    expect(documentPathAtMouse(terminal, screen, 5, 105)).toBeNull();
  });

  test("opens only when a plain left press and release stay on the same path", () => {
    const path = "/home/user/docs/readme.md";
    const cells = [...path].map((character) => ({ getWidth: () => 1, getChars: () => character }));
    const terminal = {
      cols: 100,
      rows: 10,
      buffer: {
        active: {
          viewportY: 0,
          getLine: (index: number) => index === 0
            ? { length: cells.length, getCell: (cell: number) => cells[cell] }
            : undefined,
        },
      },
    } as unknown as Terminal;
    const listeners = new Map<string, (event: MouseEvent) => void>();
    const mount = {
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100 }),
      }),
      addEventListener: (type: string, listener: (event: MouseEvent) => void) => listeners.set(type, listener),
    } as unknown as HTMLElement;
    const opened: string[] = [];
    registerDocumentLinkMouseActivation(terminal, mount, (url) => opened.push(url));
    const event = (clientX: number) => ({
      button: 0,
      clientX,
      clientY: 5,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    }) as MouseEvent;
    listeners.get("mousedown")!(event(5));
    listeners.get("mouseup")!(event(50));
    expect(opened).toEqual([previewUrl(path)]);
    listeners.get("mousedown")!(event(5));
    listeners.get("mouseup")!(event(995));
    expect(opened).toHaveLength(1);
  });

  test("creates same-origin encoded preview and resolver URLs without dropping path components", () => {
    expect(previewUrl("/home/user/设计 文档.md")).toBe(
      "/preview?path=%2Fhome%2Fuser%2F%E8%AE%BE%E8%AE%A1%20%E6%96%87%E6%A1%A3.md",
    );
    expect(previewUrl("/home/admin/github/cnyarx/xian/为什么标准超弦理论要求十维.md")).toBe(
      "/preview?path=%2Fhome%2Fadmin%2Fgithub%2Fcnyarx%2Fxian%2F%E4%B8%BA%E4%BB%80%E4%B9%88%E6%A0%87%E5%87%86%E8%B6%85%E5%BC%A6%E7%90%86%E8%AE%BA%E8%A6%81%E6%B1%82%E5%8D%81%E7%BB%B4.md",
    );
    expect(previewUrl("handoffs/HANDOFF_DocumentLinks.md")).toBe(
      "/api/resolve-terminal-path?path=handoffs%2FHANDOFF_DocumentLinks.md",
    );
  });
});
