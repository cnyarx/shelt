import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { WrappedCellOffset } from "./document-links.ts";

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
    if (text[before - 1] === "\n") {
      before--;
      while (before > 0 && /[ \t]/.test(text[before - 1]!)) before--;
    }
    const opener = text[before - 1];
    const closer = opener === "(" ? ")" : opener === "（" ? "）" : undefined;
    let depth = 0, end = scheme.lastIndex, firstBreak = -1, authorityEnded = false;
    let authorityAtBreak: URL | undefined;
    for (; end < text.length; end++) {
      if (text[end] === "\n" && closer) {
        let next = end + 1;
        while (text[next] === " " || text[next] === "\t") next++;
        if (next === text.length || URL_END.test(text[next]!) || /^https?:\/\//i.test(text.slice(next, next + 8))) break;
        if (!authorityEnded) {
          const c = text[next];
          const port = c === ":" && /^:\d{1,5}(?=[/?#)）])/.test(text.slice(next, next + 7));
          if (!port && !(c === "/" && text[next + 1] !== "/") && c !== "?" && c !== "#") break;
          try { authorityAtBreak = new URL(text.slice(start, end)); } catch { break; }
          authorityEnded = true;
        }
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
    let closed = closer !== undefined && text[end] === closer;
    if (closed && authorityAtBreak) {
      try {
        const target = new URL(text.slice(start, end).replace(/\n[ \t]*/g, ""));
        closed = target.hostname === authorityAtBreak.hostname && target.username === authorityAtBreak.username && target.password === authorityAtBreak.password;
      } catch { closed = false; }
    }
    if (firstBreak !== -1 && !closed) end = firstBreak;
    const raw = text.slice(start, end);
    const destination = closed || text.endsWith("](", before) ? raw : raw.replace(TRAILING_PUNCTUATION, "");
    const url = firstBreak === -1 ? destination : destination.replace(/\n[ \t]*/g, "");
    if (url.length > match[0].length) matches.push({ url, start, end: start + destination.length });
    scheme.lastIndex = end;
  }
  return matches;
}

type LinkBlock = { content: string; start: number; offsets: WrappedCellOffset[] };

function bufferLinks(terminal: Terminal, mount: HTMLElement, open: (url: string) => void): Map<number, ILink[]> {
  const buffer = terminal.buffer.active;
  const lines: { text: string; cells: WrappedCellOffset[]; borders: Map<number, number>; wrapped: boolean }[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y), cells: WrappedCellOffset[] = [], borders = new Map<number, number>();
    let text = "";
    for (let x = 0; line && x < Math.min(terminal.cols, line.length); x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ", start = text.length;
      text += chars;
      cells.push({ start, end: text.length, line: y + 1, cell: x });
      if (/^[│┃║▕▐]$/u.test(chars)) borders.set(x, cells.length - 1);
    }
    lines.push({ text, cells, borders, wrapped: line?.isWrapped ?? false });
  }
  const rows = new Map<number, ILink[]>();
  let lanes = new Map<string, LinkBlock[]>();
  for (const [y, line] of lines.entries()) {
    // Herdr paints the sidebar and panes on the same physical row. Follow aligned
    // vertical edges on adjacent rows, not the start of the next screen row.
    const next = new Map<string, LinkBlock[]>();
    let left = 0, cellIndex = 0, offset = 0;
    const append = (right: number, end: number) => {
      const key = `${left}:${right}`;
      const blocks = lanes.get(key) ?? [];
      lanes.delete(key);
      next.set(key, blocks);
      const wrapped = left === 0 && right === terminal.cols && line.wrapped;
      const prev = blocks.at(-1);
      const block = wrapped && prev ? prev : { content: "", start: prev ? prev.start + prev.content.length + 1 : 0, offsets: [] };
      if (block !== prev) blocks.push(block);
      const content = line.text.slice(offset, end);
      const delta = block.content.length - offset;
      for (; cellIndex < line.cells.length && line.cells[cellIndex]!.cell < right; cellIndex++) {
        const cell = line.cells[cellIndex]!;
        block.offsets.push(delta === 0 ? cell : { ...cell, start: cell.start + delta, end: cell.end + delta });
      }
      const wrapsNext = left === 0 && right === terminal.cols && lines[y + 1]?.wrapped;
      block.content += wrapsNext ? content : content.trimEnd();
    };
    for (const [x, index] of line.borders) {
      if (!lines[y - 1]?.borders.has(x) && !lines[y + 1]?.borders.has(x)) continue;
      const edge = line.cells[index]!;
      if (x > left) append(x, edge.start);
      left = x + 1; offset = edge.end; cellIndex = index + 1;
    }
    if (left < terminal.cols) append(terminal.cols, line.text.length);
    for (const blocks of lanes.values()) indexLinks(blocks, rows, mount, open);
    lanes = next;
  }
  for (const blocks of lanes.values()) indexLinks(blocks, rows, mount, open);
  return rows;
}

function indexLinks(blocks: LinkBlock[], rows: Map<number, ILink[]>, mount: HTMLElement, open: (url: string) => void): void {
  const matches = findUrls(blocks.map(b => b.content).join("\n"));
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
