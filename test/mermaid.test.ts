import { describe, expect, test } from "bun:test";
import { renderMermaid } from "@vercel/beautiful-mermaid";

const diagrams = {
  flowchart: "flowchart TD\n  A[Start] --> B[Done]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello",
  class: "classDiagram\n  Animal <|-- Duck",
  state: "stateDiagram-v2\n  [*] --> Ready\n  Ready --> [*]",
  er: "erDiagram\n  USER ||--o{ ORDER : places",
};

describe("lightweight Mermaid renderer", () => {
  for (const [name, source] of Object.entries(diagrams)) {
    test(`renders ${name}`, async () => {
      const svg = await renderMermaid(source, { transparent: true });
      expect(svg).toStartWith("<svg");
      expect(svg).toContain("</svg>");
      expect(svg).not.toContain("<script");
    });
  }

  test("rejects unsupported diagram types without affecting the caller", async () => {
    await expect(renderMermaid("gantt\n  title Unsupported")).rejects.toThrow();
  });
});
