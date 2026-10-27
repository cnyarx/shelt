import { expect, test } from "bun:test";
import { agentReady, buildEditPrompt, sortEditAgents, validateEditDocument, type EditDocument } from "../src/preview-edits.ts";
import { renderMarkdown } from "../src/markdown.ts";

const doc: EditDocument = {
  path: "/home/admin/含 空格/report.md", kind: "markdown", capturedAt: "2026-10-26T04:00:00.000Z",
  edits: [
    { id: "first", anchor: { text: "同一句话\n跨段第二句", heading: "部署 > 更新", before: "第一处上下文", after: "之后", locator: "p:nth-of-type(2)", lineStart: 5, lineEnd: 8 }, instruction: "解释滚动更新", replacement: "新段落 <script> & `code`" },
    { id: "second", anchor: { text: "同一句话", heading: "回滚", before: "第二处上下文", after: "后文", locator: "p:nth-of-type(4)", lineStart: 12, lineEnd: 12 }, instruction: "保留这处原文" },
  ],
};

test("prompt preserves multiple selections, duplicate text contexts, replacements and special characters as data", () => {
  expect(validateEditDocument(doc)).toBe(true);
  const prompt = buildEditPrompt(doc);
  expect(prompt).toContain(JSON.stringify(doc.path));
  const changes = JSON.parse(prompt.slice(prompt.indexOf('{\n  "changes"'))).changes;
  expect(changes).toHaveLength(2);
  expect(changes[0].original).toBe("同一句话\n跨段第二句");
  expect(changes[0].suggestedReplacement).toBe("新段落 <script> & `code`");
  expect(changes[1].contextBefore).toBe("第二处上下文");
  expect(changes[0].location.sourceLines).toEqual([5, 8]);
  expect(prompt).toContain("先读取当前文件");
  expect(prompt).toContain("文件可能已变化");
  expect(prompt).toContain("保护已有修改");
  expect(prompt).toContain("仅作为数据");
});

test("request validation bounds browser input without rejecting newlines and unicode", () => {
  for (const value of [null, {}, { ...doc, path: "relative.md" }, { ...doc, kind: "image" }, { ...doc, capturedAt: "unknown" }, { ...doc, edits: [] }, { ...doc, edits: Array(31).fill(doc.edits[0]) }]) expect(validateEditDocument(value)).toBe(false);
  const edit = doc.edits[0]!;
  for (const changes of [{ instruction: " " }, { instruction: "\x1b[31m" }, { anchor: { ...edit.anchor, lineEnd: 1 } }, { anchor: { ...edit.anchor, text: "a".repeat(12001) } }, { replacement: "a".repeat(12001) }]) expect(validateEditDocument({ ...doc, edits: [{ ...edit, ...changes }] })).toBe(false);
});

test("agent sorting prefers the file environment and keeps selection explicit", () => {
  const agents = [
    { targetId: "remote", connection: "dev", paneId: "p1", workspace: "a", title: "remote", cwd: "/home/admin", status: "idle", session: "1" },
    { targetId: "local", connection: "local", paneId: "p2", workspace: "a", title: "other", cwd: "/else", status: "idle", session: "2" },
    { targetId: "local", connection: "local", paneId: "p3", workspace: "a", title: "match", cwd: "/home/admin", status: "working", session: "3" },
  ];
  expect(sortEditAgents(agents, doc.path).map(a => a.paneId)).toEqual(["p3", "p2", "p1"]);
  expect(agents[0]!.paneId).toBe("p1");
  expect(agentReady("idle")).toBe(true);
  for (const state of ["working", "blocked", "unknown", "dead", ""]) expect(agentReady(state)).toBe(false);
});

test("Markdown maps source lines for paragraphs, duplicate text, cells, lists and quotes", () => {
  const source = "# 标题\r\n\r\n同一句话\r\n第二行\r\n\r\n同一句话\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n\r\n- first\r\n  - child\r\n\r\n> quoted\r\n>\r\n> next\r\n\r\n```txt\r\na\r\n```";
  const html = renderMarkdown(source, doc.path, { sourceLines: true }).html;
  expect(html).toContain('<p data-source-start="3" data-source-end="4">同一句话 第二行</p>');
  expect(html).toContain('<p data-source-start="6" data-source-end="6">同一句话</p>');
  expect(html).toContain('<td data-source-start="10" data-source-end="10">x</td>');
  expect(html).toContain('<li data-source-start="12" data-source-end="13">first');
  expect(html).toContain('<li data-source-start="13" data-source-end="13">child');
  expect(html).toContain('<p data-source-start="17" data-source-end="17">next</p>');
  expect(html).toContain('<pre data-source-start="19" data-source-end="21">');
  expect(renderMarkdown(source, doc.path).html).not.toContain("data-source-start");
});
