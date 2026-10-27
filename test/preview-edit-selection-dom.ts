import { anchorForBlocks, anchorForSelection } from "../src/preview-edit-selection.ts";

export function checkDomSelections(root: HTMLElement): void {
  const blocks = root.querySelectorAll<HTMLElement>("p");
  const first = blocks[0]!, last = blocks[1]!;
  const range = document.createRange();
  range.setStart(first.firstChild!, 1); range.setEnd(last.firstChild!, 3);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const anchor = anchorForSelection(root, selection);
  if (!anchor?.text || anchor.lineStart !== 1 || anchor.lineEnd !== 4) throw new Error("Cross-block selection lost source range");
  if (!anchorForBlocks(root, [last])?.locator) throw new Error("Missing HTML locator");
  selection.removeAllRanges();
}
