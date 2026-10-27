import { expect, test } from "bun:test";
import { anchorForBlocks, htmlLocator } from "../src/preview-edit-selection.ts";

function tree() {
  const root: any = { children: [] };
  const create = (tagName: string, text: string, start?: number, id = ""): any => {
    const el: any = {
      tagName, localName: tagName.toLowerCase(), textContent: text, parentElement: root, children: [], id,
      dataset: start ? { sourceStart: String(start), sourceEnd: String(start + 1) } : {},
      contains(other: unknown) { return other === el; },
      closest(selector: string) { return selector === "[data-source-start]" && start ? el : null; },
      compareDocumentPosition(other: any) { return root.children.indexOf(el) < root.children.indexOf(other) ? 4 : 2; },
    };
    root.children.push(el); return el;
  };
  root.querySelectorAll = (selector: string) => selector === "h1,h2,h3,h4,h5,h6" ? root.children.filter((e: any) => /^H[1-6]$/.test(e.tagName)) : root.children;
  const heading = create("H1", "Overview", 1, "overview");
  const first = create("P", "duplicate", 3);
  const middle = create("P", "context A", 5);
  const second = create("P", "duplicate", 7);
  const last = create("P", "context B", 9);
  return { root, heading, first, middle, second, last };
}

test("same text in different blocks gets distinct source locations and neighboring context", () => {
  const t = tree();
  const one = anchorForBlocks(t.root, [t.first])!, two = anchorForBlocks(t.root, [t.second])!;
  expect(one.text).toBe(two.text);
  expect(one.lineStart).toBe(3); expect(two.lineStart).toBe(7);
  expect(one.after).toBe("context A"); expect(two.before).toBe("context A"); expect(two.after).toBe("context B");
  expect(one.locator).not.toBe(two.locator);
  expect(two.heading).toBe("Overview");
});

test("multi-block selection retains the source span and exact selected text", () => {
  const t = tree();
  const anchor = anchorForBlocks(t.root, [t.first, t.middle, t.second], "duplicate\ncontext A\nduplicate")!;
  expect(anchor.lineStart).toBe(3); expect(anchor.lineEnd).toBe(8);
  expect(anchor.text).toBe("duplicate\ncontext A\nduplicate");
  expect(anchor.before).toBe("Overview"); expect(anchor.after).toBe("context B");
  expect(anchorForBlocks(t.root, [], "text")).toBeNull();
  expect(anchorForBlocks(t.root, [t.first], "a".repeat(12001))).toBeNull();
});

test("HTML locator keeps explicit IDs as quoted data including special characters", () => {
  const t = tree(); t.first.id = 'a" <script> b';
  expect(htmlLocator(t.first)).toBe('p[id="a\\" <script> b"]');
});
