import type { EditAnchor } from "./preview-edits.ts";

export const EDIT_BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,th,td,figcaption,figure,[data-source-start]";
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

export function editBlocks(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(EDIT_BLOCKS)].filter(el => {
    const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
    return !!el.textContent?.trim() && !el.closest("script,style,template,nav,[hidden]") && style?.display !== "none" && style?.visibility !== "hidden";
  });
}

export function htmlLocator(element: Element): string {
  const parts: string[] = [];
  for (let el: Element | null = element; el && el.localName !== "html"; el = el.parentElement) {
    if (el.id) { parts.unshift(`${el.localName}[id=${JSON.stringify(el.id)}]`); break; }
    const peers = el.parentElement ? [...el.parentElement.children].filter(child => child.localName === el!.localName) : [el];
    parts.unshift(`${el.localName}:nth-of-type(${peers.indexOf(el) + 1})`);
    if (parts.length >= 12) break;
  }
  return parts.join(" > ");
}

export function anchorForBlocks(root: ParentNode, blocks: HTMLElement[], text?: string): EditAnchor | null {
  if (!blocks.length) return null;
  const all = editBlocks(root);
  const first = blocks[0]!, last = blocks[blocks.length - 1]!;
  const headingStack: { level: number; text: string }[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
    if (heading !== first && !(heading.compareDocumentPosition(first) & 4)) break;
    const level = Number(heading.tagName.slice(1));
    while (headingStack.length && headingStack.at(-1)!.level >= level) headingStack.pop();
    headingStack.push({ level, text: compact(heading.textContent || "") });
  }
  const outside = (el: HTMLElement) => !blocks.some(block => el === block || el.contains(block) || block.contains(el));
  const before = all.slice(0, all.indexOf(first)).filter(outside).at(-1);
  const after = all.slice(all.indexOf(last) + 1).find(outside);
  const mapped = blocks.map(el => el.closest<HTMLElement>("[data-source-start]")).filter((el): el is HTMLElement => !!el);
  const starts = mapped.map(el => Number(el.dataset.sourceStart)).filter(Number.isFinite);
  const ends = mapped.map(el => Number(el.dataset.sourceEnd)).filter(Number.isFinite);
  const selected = (text ?? blocks.map(el => el.textContent?.trim() || "").join("\n")).trim();
  if (!selected || selected.length > 12000) return null;
  return {
    text: selected,
    heading: headingStack.map(h => h.text).join(" > ").slice(0, 1000),
    before: compact(before?.textContent || "").slice(-1000),
    after: compact(after?.textContent || "").slice(0, 1000),
    locator: htmlLocator(first).slice(0, 2000),
    ...(starts.length ? { lineStart: Math.min(...starts), lineEnd: Math.max(...ends) } : {}),
  };
}

export function anchorForSelection(root: ParentNode, selection: Selection | null): EditAnchor | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const blocks = editBlocks(root).filter(el => range.intersectsNode(el));
  const leaves = blocks.filter(el => !blocks.some(other => other !== el && el.contains(other)));
  const anchor = anchorForBlocks(root, leaves, selection.toString());
  if (!anchor || !leaves.length) return anchor;
  const first = leaves[0]!, last = leaves.at(-1)!;
  const before = range.cloneRange(), after = range.cloneRange();
  before.selectNodeContents(first);
  if (first.contains(range.startContainer)) before.setEnd(range.startContainer, range.startOffset);
  after.selectNodeContents(last);
  if (last.contains(range.endContainer)) after.setStart(range.endContainer, range.endOffset);
  const prefix = first.contains(range.startContainer) ? compact(before.toString()) : "";
  const suffix = last.contains(range.endContainer) ? compact(after.toString()) : "";
  if (prefix) anchor.before = prefix.slice(-1000);
  if (suffix) anchor.after = suffix.slice(0, 1000);
  return anchor;
}
