import type { Terminal } from "@xterm/xterm";
import { normalizeTtsText, splitTtsText } from "./tts.ts";

export type SpeechRow = { text: string; kind: "body" | "start" | "boundary"; row: number };
export type SpeechRegion = { left: number; right: number; top: number; bottom: number; marker: number };
export type SpeechView = { region: SpeechRegion; rows: SpeechRow[]; context: string };
export type SpeechBlock = { start: number; end: number; text: string; closed: boolean };
export type SpeechGrid = { lines: string[][]; cursorX: number; cursorY: number; chrome?: string };

const FOOTER = /(?:Context\s+[\d.]+%|(?:YOLO|auto[- ]?edit|plan|default) mode|shift\+tab to cycle|MCPs? offline)/iu;
const COMPRESSION = /^(?:Chat history compress|Compression was not beneficial|Could not compress chat history|Nothing to compress\.|Context compressed|聊天历史.{0,8}压缩|对话历史.{0,8}压缩)/iu;
const PREFIX = /^[◆∵∴>\u25b3\u25cf\u2715\u2713\u21bb\u25ce\u203b?⊷ox$-]/u;
const VERTICAL = /^[│┃║]$/u;
const SCROLLBAR = /^[│┃║█▇▆▅▄▃▂▁▏▎▍▌▋▊▉]$/u;
const HORIZONTAL = /^[\s─━═╭╮╰╯┌┐└┘├┤┬┴┼│┃║]+$/u;

export function readSpeechGrid(terminal: Terminal): SpeechGrid {
  const buffer = terminal.buffer.active;
  const header = buffer.getLine(buffer.viewportY);
  const chrome = Array.from({ length: terminal.cols }, (_, column) => {
    const cell = header?.getCell(column);
    return cell ? [cell.getChars(), cell.getBgColorMode(), cell.getBgColor(), cell.isInverse()] : [];
  });
  return {
    chrome: JSON.stringify(chrome),
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY + buffer.baseY - buffer.viewportY,
    lines: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: terminal.cols }, (_, column) => {
        const cell = line?.getCell(column);
        return cell?.getWidth() === 0 ? "" : cell?.getChars() || " ";
      });
    }),
  };
}

function lineText(grid: SpeechGrid, row: number, left: number, right: number): string {
  return (grid.lines[row] ?? []).slice(left, right).join("").replace(/[\ufe0e\ufe0f]/gu, "").trimEnd();
}

export function speechView(grid: SpeechGrid, anchor = { x: grid.cursorX, y: grid.cursorY }, previous?: SpeechRegion): SpeechView | null {
  const height = grid.lines.length;
  const width = grid.lines[0]?.length ?? 0;
  if (!width || height < 5 || anchor.x < 0 || anchor.x >= width || anchor.y < 0 || anchor.y >= height) return null;
  const separators: number[] = [];
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 1; y < height; y++) if (VERTICAL.test(grid.lines[y]?.[x] ?? "")) count++;
    if (count >= Math.max(4, (height - 1) * 0.65) && VERTICAL.test(grid.lines[height - 2]?.[x] ?? "")) separators.push(x);
  }
  const left = (separators.findLast((x) => x < anchor.x) ?? -1) + 1;
  const paneRight = separators.find((x) => x >= anchor.x) ?? width;
  if (paneRight - left < 12) return null;

  let bottom = -1;
  let right = paneRight;
  const inputTops = new Set<number>();
  // Herdr can letterbox a smaller application's viewport inside a larger client.
  for (let footer = height - 1; footer > 2; footer--) {
    if (!FOOTER.test(lineText(grid, footer, left, paneRight))) continue;
    const borders: { row: number; right: number }[] = [];
    for (let row = Math.max(1, footer - 12); row < footer; row++) {
      const text = lineText(grid, row, left, paneRight);
      if (!HORIZONTAL.test(text) || (text.match(/[─━═]/gu)?.length ?? 0) < 12) continue;
      let edge = paneRight;
      while (edge > left && !(grid.lines[row]?.[edge - 1] ?? "").trim()) edge--;
      borders.push({ row, right: edge });
    }
    const upper = borders.at(-2), lower = borders.at(-1);
    if (!upper || !lower || upper.right !== lower.right || lower.row - upper.row < 2) continue;
    inputTops.add(upper.row);
    if (bottom < 0) { bottom = upper.row; right = upper.right; }
  }
  if (bottom < 2 || inputTops.size !== 1 || anchor.x >= right) return null;
  const top = separators.length ? 1 : 0;
  for (let row = top; row < bottom; row++) {
    if (FOOTER.test(lineText(grid, row, left, Math.min(left + 10, right)))) return null;
  }
  let marker: number | undefined;
  for (let row = top; row < bottom; row++) {
    for (let x = left; x < Math.min(right, left + 3); x++) {
      const char = (grid.lines[row]?.[x] ?? " ").replace(/[\ufe0e\ufe0f]/gu, "");
      if (!char.trim()) continue;
      if (PREFIX.test(char) && /^\s*$/u.test(lineText(grid, row, left, x))) marker = Math.min(marker ?? x, x);
      break;
    }
  }
  marker ??= previous?.left === left && previous.right === right ? previous.marker : left + 2;
  let textRight = right;
  for (let column = right - 1; column >= Math.max(marker + 2, right - 2); column--) {
    let barRows = 0;
    for (let row = top; row < bottom; row++) if (SCROLLBAR.test(grid.lines[row]?.[column] ?? "")) barRows++;
    if (barRows >= Math.max(4, (bottom - top) * 0.65)) textRight = column;
  }
  const rows: SpeechRow[] = [];
  for (let row = top; row < bottom; row++) {
    const prefix = lineText(grid, row, marker, Math.min(marker + 2, textRight));
    const text = lineText(grid, row, marker + 2, textRight);
    const outer = lineText(grid, row, left, marker);
    if (outer.trim()) {
      rows.push({ row, text: lineText(grid, row, left, textRight), kind: "boundary" });
    } else if (/^◆\s?$/u.test(prefix)) {
      rows.push({ row, text, kind: COMPRESSION.test(text) ? "boundary" : "start" });
    } else if (prefix.trim()) {
      rows.push({ row, text: `${prefix}${text}`, kind: "boundary" });
    } else {
      rows.push({ row, text, kind: "body" });
    }
  }
  while (rows.length && !rows[0]!.text.trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1]!.text.trim()) rows.pop();
  const context = `${left}:${right}:${top}:${marker}|${separators.length ? grid.chrome ?? lineText(grid, 0, 0, width) : "qwen"}`;
  return { region: { left, right, top, bottom, marker }, rows, context };
}

function sameRow(left: SpeechRow, right: SpeechRow): boolean {
  return left.kind === right.kind && left.text === right.text;
}

export function alignSpeechRows(previous: SpeechRow[], next: SpeechRow[]): number | null {
  if (!previous.length) return 0;
  if (!next.length) return null;
  if (previous.length === next.length && previous.every((row, index) => sameRow(row, next[index]!))) return 0;
  if (previous.length <= next.length && previous.every((row, index) => {
    const current = next[index]!;
    return row.kind === current.kind && current.text.startsWith(row.text);
  })) return 0;
  const scores = new Map<number, number>();
  for (let i = 0; i < previous.length; i++) {
    const row = previous[i]!;
    if (!row.text.trim()) continue;
    for (let j = 0; j < next.length; j++) {
      if (!sameRow(row, next[j]!)) continue;
      const offset = i - j;
      scores.set(offset, (scores.get(offset) ?? 0) + Math.min(80, [...row.text].length) + 8);
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= 24 && ranked[0][1] !== ranked[1]?.[1]) return ranked[0][0];
  // A streaming first line can grow without producing another physical row.
  if (previous[0]?.kind === "start" && next[0]?.kind === "start"
    && previous[0].text.length >= 4 && next[0].text.startsWith(previous[0].text)) return 0;
  return null;
}

export class SpeechTranscript {
  private tape = new Map<number, SpeechRow>();
  private previous: SpeechRow[] = [];
  private offset = 0;
  private context: string | undefined;
  private signature = "";
  changedAt = 0;
  view: SpeechView | undefined;

  update(view: SpeechView, now = Date.now()): boolean {
    if (this.context !== undefined && this.context !== view.context) return false;
    const shift = alignSpeechRows(this.previous, view.rows);
    if (shift === null) return false;
    this.offset += shift;
    for (let i = 0; i < view.rows.length; i++) this.tape.set(this.offset + i, view.rows[i]!);
    // A growing input box clips history rather than deleting its content.
    if (shift === 0 && view.rows.length < this.previous.length && view.region.bottom === this.view?.region.bottom) {
      for (let i = view.rows.length; i < this.previous.length; i++) this.tape.delete(this.offset + i);
    }
    if (this.tape.size > 8000) return false;
    const signature = JSON.stringify(view.rows.map(({ kind, text }) => [kind, text]));
    if (signature !== this.signature) this.changedAt = now;
    this.signature = signature;
    this.context = view.context;
    this.previous = view.rows;
    this.view = view;
    return true;
  }

  indexAtRow(row: number): number | undefined {
    const index = this.previous.findIndex((line) => line.row === row);
    return index < 0 ? undefined : this.offset + index;
  }

  rowAtIndex(index: number): number | undefined {
    return this.previous[index - this.offset]?.row;
  }

  blocks(): SpeechBlock[] {
    const result: SpeechBlock[] = [];
    let current: { start: number; end: number; lines: string[] } | undefined;
    const finish = (closed: boolean) => {
      if (current) result.push({ start: current.start, end: current.end, text: normalizeTtsText(current.lines.join("\n")), closed });
      current = undefined;
    };
    for (const [index, row] of [...this.tape].sort((a, b) => a[0] - b[0])) {
      if (row.kind !== "body") finish(true);
      if (row.kind === "start") current = { start: index, end: index, lines: [row.text] };
      else if (current) { current.lines.push(row.text); current.end = index; }
    }
    finish(false);
    return result;
  }

  blockAt(index: number): SpeechBlock | undefined {
    return this.blocks().find((block) => block.start <= index && block.end >= index);
  }
}

export function readySpeechText(text: string, consumed: number, flush = false): { chunks: string[]; end: number } {
  const remaining = text.slice(consumed);
  let length = flush ? remaining.length : 0;
  if (!flush) {
    for (const match of remaining.matchAll(/[。！？；!?;](?:[”’」』）)]*)|\.(?=\s|$)/gu)) length = match.index! + match[0].length;
  }
  const ready = remaining.slice(0, length);
  return { chunks: splitTtsText(ready, 400), end: consumed + length };
}
