import { describe, expect, test } from "bun:test";
import { MAX_MERMAID_SOURCE_BYTES, localImagePreviewUrl, renderMarkdown, wikiLinkUrl } from "../src/markdown.ts";

describe("Markdown preview", () => {
  test("renders common reading syntax and escapes raw HTML", () => {
    const rendered = renderMarkdown("# Title\n\n**bold** and `code`\n\n- one\n- two\n\n<script>alert(1)</script>", "/home/user/docs/readme.md");
    expect(rendered.html).toContain('<h1 id="title">Title</h1>');
    expect(rendered.html).toContain("<strong>bold</strong>");
    expect(rendered.html).toContain("<code>code</code>");
    expect(rendered.html).toContain("<ul>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).not.toContain("<script>");
  });

  test("rewrites local relative images through the controlled API", () => {
    expect(localImagePreviewUrl("../images/架构 图.png", "/home/user/docs/readme.md")).toBe(
      "/api/preview?path=%2Fhome%2Fuser%2Fimages%2F%E6%9E%B6%E6%9E%84%20%E5%9B%BE.png",
    );
    const rendered = renderMarkdown("![diagram](./images/a.png)", "/home/user/docs/readme.md");
    expect(rendered.html).toContain("/api/preview?path=%2Fhome%2Fuser%2Fdocs%2Fimages%2Fa.png");
    expect(rendered.html).not.toContain("file://");
  });

  test("rejects active link and image protocols", () => {
    const rendered = renderMarkdown("[bad](javascript:alert(1)) ![bad](https://evil.example/a.png)", "/home/user/readme.md");
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).not.toContain("https://evil.example");
  });

  test("renders Obsidian wiki links, aliases, and heading anchors without touching code or embeds", () => {
    const documentPath = "/home/admin/github/cnyarx/xian/计算机学/长上下文.md";
    const rendered = renderMarkdown([
      "# 局部 到整体",
      "[[物理学/弦理论]] [[物理学/Weyl 反常|Weyl 反常]] [[数学/局部到整体#局部 到整体|章节]]",
      "[[#局部 到整体|本页章节]] `[[代码/不解析]]` ![[尚未支持的嵌入]]",
    ].join("\n\n"), documentPath);
    expect(rendered.html).toContain('<h1 id="局部-到整体">局部 到整体</h1>');
    expect(rendered.html).toContain('class="wikilink"');
    expect(rendered.html).toContain("target=%E7%89%A9%E7%90%86%E5%AD%A6%2F%E5%BC%A6%E7%90%86%E8%AE%BA");
    expect(rendered.html).toContain(">Weyl 反常</a>");
    expect(rendered.html).toContain("heading=%E5%B1%80%E9%83%A8-%E5%88%B0%E6%95%B4%E4%BD%93");
    expect(rendered.html).toContain('<a class="wikilink" href="#%E5%B1%80%E9%83%A8-%E5%88%B0%E6%95%B4%E4%BD%93">本页章节</a>');
    expect(rendered.html).toContain("<code>[[代码/不解析]]</code>");
    expect(rendered.html).toContain("![[尚未支持的嵌入]]");
  });

  test("rejects unsafe wiki link targets", () => {
    expect(wikiLinkUrl("../etc/passwd", "/home/user/docs/readme.md")).toBeNull();
    expect(wikiLinkUrl("/etc/passwd", "/home/user/docs/readme.md")).toBeNull();
    expect(wikiLinkUrl("safe//broken", "/home/user/docs/readme.md")).toBeNull();
    expect(wikiLinkUrl("safe", "relative.md")).toBeNull();
  });

  test("renders inline and display formulas as MathML without touching code", () => {
    const rendered = renderMarkdown([
      "时间是 $\\tau$，位置是 $\\sigma$。",
      "",
      "$$ X^\\mu(\\tau,\\sigma) $$",
      "",
      "`$not_math$`",
    ].join("\n"), "/home/user/readme.md");
    expect(rendered.html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML">');
    expect(rendered.html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">');
    expect(rendered.html).toContain("<mi>τ</mi>");
    expect(rendered.html).toContain("<mi>σ</mi>");
    expect(rendered.html).toContain("<code>$not_math$</code>");
  });

  test("falls back safely for invalid formulas", () => {
    const rendered = renderMarkdown("bad $\\notacommand{x}$", "/home/user/readme.md");
    expect(rendered.html).toContain('class="math-error"');
    expect(rendered.html).not.toContain("<script");
  });

  test("collects bounded Mermaid blocks and falls back for oversized source", () => {
    const rendered = renderMarkdown("```mermaid\ngraph TD\n A-->B\n```", "/home/user/readme.md");
    expect(rendered.mermaid).toEqual([{ id: "mermaid-1", source: "graph TD\n A-->B" }]);
    expect(rendered.html).toContain('data-mermaid-id="mermaid-1"');

    const oversized = renderMarkdown(`\`\`\`mermaid\n${"A".repeat(MAX_MERMAID_SOURCE_BYTES + 1)}\n\`\`\``, "/home/user/readme.md");
    expect(oversized.mermaid).toEqual([]);
    expect(oversized.html).toContain("<pre><code");
  });
});
