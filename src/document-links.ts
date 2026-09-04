import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const EXTENSIONS = "(?:md|markdown|html?|svg|png|jpe?g|gif|webp)";
const PATH_START = "(?:/(?!/)|\\.{1,2}/|[^\\s/\"'\\x60:=\\uff1a\\uff0c\\u3001\\u2500-\\u257f()\\[\\]{}]+/)";
const QUOTED_PATH = new RegExp(`(["'\\x60])(${PATH_START}(?:\\\\.|(?!\\1).)+?\\.${EXTENSIONS})(?::\\d+(?::\\d+)?|#L\\d+(?:C\\d+)?)?\\1`, "giu");
const BARE_PATH = new RegExp(`(^|[\\s(\\[{=:\\uff1a\\uff0c\\u3001\\u2500-\\u257f])(${PATH_START}(?:\\\\.|[^\\s"'\\x60])+?\\.${EXTENSIONS}(?::\\d+(?::\\d+)?|#L\\d+(?:C\\d+)?)?)`, "giu");
const SPACED_PATH = new RegExp(`(^|[\\s(\\[{=:\\uff1a\\uff0c\\u3001])(/(?!/)(?:\\\\.|[^"\\x60])+?\\.${EXTENSIONS}(?::\\d+(?::\\d+)?|#L\\d+(?:C\\d+)?)?)$`, "giu");
const LOCATION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/i;

export type DocumentPathMatch = { path: string; start: number; end: number };
export type DocumentMouseTarget = Pick<MouseEvent, "button" | "clientX" | "clientY" | "preventDefault" | "stopImmediatePropagation">;

export function findDocumentPaths(line: string): DocumentPathMatch[] {
  const matches: DocumentPathMatch[] = [];
  for (const match of line.matchAll(QUOTED_PATH)) {
    const raw = match[2]!;
    const path = unescapeShellPath(raw);
    matches.push({ path, start: match.index + 1, end: match.index + 1 + raw.length });
  }
  for (const match of line.matchAll(BARE_PATH)) {
    addBareMatch(matches, match);
  }
  for (const match of line.matchAll(SPACED_PATH)) {
    addBareMatch(matches, match);
  }
  return matches.sort((left, right) => left.start - right.start);
}

function addBareMatch(matches: DocumentPathMatch[], match: RegExpMatchArray): void {
  const prefix = match[1]!;
  const raw = match[2]!;
  const start = match.index! + prefix.length;
  if (matches.some((existing) => start >= existing.start - 1 && start < existing.end + 1)) return;
  const tokenPrefix = (match.input ?? "").slice(0, start).match(/[^\s"'`()[\]{}]+$/u)?.[0] ?? "";
  if (tokenPrefix.includes("://")) return;
  const withoutLocation = raw.replace(LOCATION_SUFFIX, "");
  if (withoutLocation.includes("://")) return;
  matches.push({
    path: unescapeShellPath(withoutLocation),
    start,
    end: start + withoutLocation.length,
  });
}

export function previewUrl(path: string): string {
  const endpoint = path.startsWith("/") ? "/preview" : "/api/resolve-terminal-path";
  return `${endpoint}?path=${encodeURIComponent(path)}`;
}

function unescapeShellPath(path: string): string {
  return path.replace(/\\([\\\s"'`])/g, "$1");
}

function documentLinksForLine(terminal: Terminal, bufferLineNumber: number): ILink[] {
  let firstLineNumber = bufferLineNumber;
  while (firstLineNumber > 1 && terminal.buffer.active.getLine(firstLineNumber - 1)?.isWrapped) {
    firstLineNumber--;
  }

  let text = "";
  const offsets: Array<{ start: number; end: number; cell: number; line: number }> = [];
  let lineNumber = firstLineNumber;
  const bufferLength = terminal.buffer.active.length || bufferLineNumber;
  while (lineNumber <= bufferLength) {
    const line = terminal.buffer.active.getLine(lineNumber - 1);
    if (!line) break;
    if (lineNumber > firstLineNumber && !line.isWrapped) break;
    const columns = terminal.cols || line.length;
    for (let cell = 0; cell < Math.min(line.length, columns); cell += 1) {
      const value = line.getCell(cell);
      if (!value || value.getWidth() === 0) continue;
      const chars = value.getChars() || " ";
      const start = text.length;
      text += chars;
      offsets.push({ start, end: text.length, cell, line: lineNumber });
    }
    lineNumber++;
  }

  return findDocumentPaths(text).flatMap<ILink>((match) => {
    const first = offsets.find((offset) => match.start >= offset.start && match.start < offset.end);
    const last = offsets.findLast((offset) => match.end > offset.start && match.end <= offset.end)
      ?? offsets.findLast((offset) => offset.start < match.end);
    if (!first || !last) return [];
    return [{
      range: {
        start: { x: first.cell + 1, y: first.line },
        end: { x: last.cell + 1, y: last.line },
      },
      text: match.path,
      activate: () => undefined,
    }];
  });
}

export function documentPathAtMouse(
  terminal: Terminal,
  screen: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  clientX: number,
  clientY: number,
): string | null {
  if (
    clientX < screen.left || clientX >= screen.right
    || clientY < screen.top || clientY >= screen.bottom
    || screen.width <= 0 || screen.height <= 0
  ) return null;
  const cellX = Math.floor((clientX - screen.left) * terminal.cols / screen.width) + 1;
  const viewportRow = Math.floor((clientY - screen.top) * terminal.rows / screen.height);
  const bufferLineNumber = terminal.buffer.active.viewportY + viewportRow + 1;
  return documentLinksForLine(terminal, bufferLineNumber).find((link) => {
    if (bufferLineNumber < link.range.start.y || bufferLineNumber > link.range.end.y) return false;
    const startX = bufferLineNumber === link.range.start.y ? link.range.start.x : 1;
    const endX = bufferLineNumber === link.range.end.y ? link.range.end.x : terminal.cols;
    return cellX >= startX && cellX <= endX;
  })?.text ?? null;
}

export function registerDocumentLinkMouseActivation(
  terminal: Terminal,
  mount: HTMLElement,
  open: (url: string) => void,
): void {
  let pressedPath: string | null = null;
  const pathAtEvent = (event: DocumentMouseTarget) => {
    const screen = mount.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect();
    return screen ? documentPathAtMouse(terminal, screen, event.clientX, event.clientY) : null;
  };
  const suppress = (event: DocumentMouseTarget) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  mount.addEventListener("mousedown", (event) => {
    pressedPath = event.button === 0 ? pathAtEvent(event) : null;
    if (pressedPath) suppress(event);
  }, true);
  mount.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || !pressedPath) return;
    const path = pathAtEvent(event);
    suppress(event);
    if (path === pressedPath) open(previewUrl(path));
    pressedPath = null;
  }, true);
}

export function createDocumentLinkIndicatorLayer(
  terminal: Terminal,
  mount: HTMLElement,
): { dispose(): void } {
  const screen = mount.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return { dispose() {} };
  screen.style.position = "relative";
  const layer = document.createElement("div");
  layer.className = "document-link-indicators";
  screen.append(layer);

  const refresh = () => {
    const cellWidth = screen.clientWidth / terminal.cols;
    const cellHeight = screen.clientHeight / terminal.rows;
    const indicators: HTMLSpanElement[] = [];
    const start = terminal.buffer.active.viewportY;
    const rendered = new Set<string>();
    for (let row = 0; row < terminal.rows; row += 1) {
      const bufferLineNumber = start + row + 1;
      for (const link of documentLinksForLine(terminal, bufferLineNumber)) {
        const key = `${link.range.start.x}:${link.range.start.y}:${link.range.end.x}:${link.range.end.y}`;
        if (rendered.has(key)) continue;
        rendered.add(key);
        const firstVisibleLine = Math.max(link.range.start.y, start + 1);
        const lastVisibleLine = Math.min(link.range.end.y, start + terminal.rows);
        for (let lineNumber = firstVisibleLine; lineNumber <= lastVisibleLine; lineNumber += 1) {
          const startX = lineNumber === link.range.start.y ? link.range.start.x : 1;
          const endX = lineNumber === link.range.end.y ? link.range.end.x : terminal.cols;
          const indicator = document.createElement("span");
          indicator.style.left = `${(startX - 1) * cellWidth}px`;
          indicator.style.top = `${(lineNumber - start - 1) * cellHeight}px`;
          indicator.style.width = `${(endX - startX + 1) * cellWidth}px`;
          indicator.style.height = `${Math.max(1, cellHeight - 2)}px`;
          indicators.push(indicator);
        }
      }
    }
    layer.replaceChildren(...indicators);
  };

  let animationFrame: number | undefined;
  const scheduleRefresh = () => {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      refresh();
    });
  };
  const screenResizeObserver = new ResizeObserver(scheduleRefresh);
  screenResizeObserver.observe(screen);
  const onWriteDisposable = terminal.onWriteParsed(scheduleRefresh);
  const onRenderDisposable = terminal.onRender(scheduleRefresh);
  const onScrollDisposable = terminal.onScroll(scheduleRefresh);
  const onResizeDisposable = terminal.onResize(scheduleRefresh);
  refresh();

  return {
    dispose() {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      screenResizeObserver.disconnect();
      onWriteDisposable.dispose();
      onRenderDisposable.dispose();
      onScrollDisposable.dispose();
      onResizeDisposable.dispose();
      layer.remove();
    },
  };
}

export function createDocumentLinkProvider(
  terminal: Terminal,
  mount: HTMLElement,
  open: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const links = documentLinksForLine(terminal, bufferLineNumber).map((link) => ({
        ...link,
        decorations: { underline: false, pointerCursor: true },
        activate: () => open(previewUrl(link.text)),
        hover: () => {
          mount.title = link.text;
          mount.classList.add("document-link-hover");
        },
        leave: () => {
          mount.removeAttribute("title");
          mount.classList.remove("document-link-hover");
        },
      }));
      callback(links.length ? links : undefined);
    },
  };
}
