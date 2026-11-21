import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { wrappedLineText, type WrappedCellOffset } from "./document-links.ts";

const URL_END = /[\s"'<>\\\x00-\x1f]/u;
const TRAILING_PUNCTUATION = /(?:[.,;:!?)\]}>'"`]|[\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff09\u3011\u300b\u3001])+$/u;

export type UrlMatch = { url: string; start: number; end: number };

export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  const scheme = /\bhttps?:\/\//giu;
  for (let match; (match = scheme.exec(text));) {
    const start = match.index;
    let before = start;
    while (before > 0 && /[ \t]/.test(text[before - 1]!)) before--;
    const opener = text[before - 1];
    const closer = opener === "(" ? ")" : opener === "（" ? "）" : undefined;
    let depth = 0, end = scheme.lastIndex, firstBreak = -1, authorityEnded = false;
    for (; end < text.length; end++) {
      if (text[end] === "\n" && closer && authorityEnded) {
        let next = end + 1;
        while (text[next] === " " || text[next] === "\t") next++;
        if (next === text.length || URL_END.test(text[next]!) || /^https?:\/\//i.test(text.slice(next, next + 8))) break;
        if (firstBreak === -1) firstBreak = end;
        end = next - 1;
        continue;
      }
      if (URL_END.test(text[end]!)) break;
      if (text[end] === "/" || text[end] === "?" || text[end] === "#") authorityEnded = true;
      if (!closer) continue;
      if (text[end] === opener) depth++;
      if (text[end] === closer) {
        if (depth === 0) break;
        depth--;
      }
    }
    // A hard break is ambiguous unless the continuation actually closes the original delimiter.
    const closed = closer !== undefined && text[end] === closer;
    if (firstBreak !== -1 && !closed) end = firstBreak;
    const raw = text.slice(start, end);
    const destination = closed || text.endsWith("](", before) ? raw : raw.replace(TRAILING_PUNCTUATION, "");
    const url = firstBreak === -1 ? destination : destination.replace(/\n[ \t]*/g, "");
    if (url.length > match[0].length) matches.push({ url, start, end: start + destination.length });
    scheme.lastIndex = end;
  }
  return matches;
}

function bufferLinks(terminal: Terminal, mount: HTMLElement, open: (url: string) => void): Map<number, ILink[]> {
  const blocks: { content: string; start: number; offsets: WrappedCellOffset[] }[] = [];
  const buffer = terminal.buffer.active;
  let start = 0;
  for (let row = 1; row <= buffer.length;) {
    const block = wrappedLineText(terminal, row);
    const content = block.text.trimEnd();
    blocks.push({ offsets: block.offsets, content, start });
    start += content.length + 1;
    row = (block.offsets.at(-1)?.line ?? row) + 1;
  }
  const matches = findUrls(blocks.map(b => b.content).join("\n"));
  const rows = new Map<number, ILink[]>();
  let firstBlock = 0;
  for (const match of matches) {
    while (firstBlock + 1 < blocks.length && blocks[firstBlock + 1]!.start <= match.start) firstBlock++;
    // A single xterm range across a hard break would also make the blank margins clickable.
    for (let i = firstBlock; i < blocks.length && blocks[i]!.start < match.end; i++) {
      const b = blocks[i]!;
      const from = i === firstBlock ? match.start - b.start : b.content.length - b.content.trimStart().length;
      const to = Math.min(match.end - b.start, b.content.length);
      if (from >= to) continue;
      const first = b.offsets.find(cell => cell.end > from);
      const last = b.offsets.findLast(cell => cell.start < to);
      if (!first || !last) continue;
      const link: ILink = {
        range: { start: { x: first.cell + 1, y: first.line }, end: { x: last.cell + 1, y: last.line } },
        text: match.url, decorations: { underline: true, pointerCursor: true },
        activate: () => open(match.url), hover: () => { mount.title = match.url; },
        leave: () => { mount.removeAttribute("title"); },
      };
      for (let row = first.line; row <= last.line; row++) {
        const links = rows.get(row);
        if (links) links.push(link); else rows.set(row, [link]);
      }
    }
  }
  return rows;
}

/** Scrollback is disabled; index the screen lazily so hovering the tail first finds the same URL. */
export function createWebLinkProvider(
  terminal: Terminal,
  mount: HTMLElement,
  open: (url: string) => void,
): ILinkProvider & { containsCell: (x: number, y: number) => boolean } {
  let cache: Map<number, ILink[]> | undefined;
  terminal.onWriteParsed(() => { cache = undefined; });
  terminal.onResize(() => { cache = undefined; });
  const linksOn = (row: number) => (cache ??= bufferLinks(terminal, mount, open)).get(row);
  return {
    provideLinks(row, callback) { callback(linksOn(row)); },
    containsCell: (x, y) => linksOn(y)?.some(({ range }) =>
      (y > range.start.y || x >= range.start.x) && (y < range.end.y || x <= range.end.x)) ?? false,
  };
}
