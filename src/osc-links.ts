import type { IBufferRange, IDisposable, ILinkHandler, Terminal } from "@xterm/xterm";

type HoveredLink = { url: string; range: IBufferRange };

export function installOscLinkHandling(
  terminal: Terminal,
  mount: HTMLElement,
  open: (url: string) => void,
): IDisposable {
  let hovered: HoveredLink | undefined;
  let pressed: HoveredLink | undefined;
  const previous = terminal.options.linkHandler;
  const safeUrl = (url: string): boolean => {
    try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
  };
  const atEvent = (link: HoveredLink | undefined, event: MouseEvent): boolean => {
    if (!link) return false;
    const screen = mount.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect();
    if (!screen || screen.width <= 0 || screen.height <= 0 || event.clientX < screen.left || event.clientX >= screen.right || event.clientY < screen.top || event.clientY >= screen.bottom) return false;
    const x = Math.floor((event.clientX - screen.left) * terminal.cols / screen.width) + 1;
    const y = terminal.buffer.active.viewportY + Math.floor((event.clientY - screen.top) * terminal.rows / screen.height) + 1;
    return y >= link.range.start.y && y <= link.range.end.y
      && x >= (y === link.range.start.y ? link.range.start.x : 1)
      && x <= (y === link.range.end.y ? link.range.end.x : terminal.cols);
  };
  const sameLink = (a: HoveredLink, b: HoveredLink): boolean => a.url === b.url
    && a.range.start.x === b.range.start.x && a.range.start.y === b.range.start.y
    && a.range.end.x === b.range.end.x && a.range.end.y === b.range.end.y;
  const suppress = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const handler: ILinkHandler = {
    activate: (event, url) => { if (event.button === 0 && !event.shiftKey && safeUrl(url)) open(url); },
    hover: (_event, url, range) => {
      hovered = safeUrl(url) ? { url, range: { start: { ...range.start }, end: { ...range.end } } } : undefined;
      if (hovered) mount.title = hovered.url;
    },
    leave: () => { hovered = undefined; mount.removeAttribute("title"); },
  };
  const down = (event: MouseEvent) => {
    pressed = event.button === 0 && !event.shiftKey && atEvent(hovered, event) ? hovered : undefined;
    if (pressed) suppress(event);
  };
  const up = (event: MouseEvent) => {
    if (event.button !== 0 || !pressed) return;
    const original = pressed;
    pressed = undefined;
    suppress(event);
    // A TUI repaint replaces xterm's link object between press and release even when the link is unchanged.
    if (hovered && sameLink(original, hovered) && atEvent(hovered, event)) open(hovered.url);
  };
  const reset = () => { pressed = undefined; hovered = undefined; mount.removeAttribute("title"); };
  terminal.options.linkHandler = handler;
  mount.addEventListener("mousedown", down, true);
  mount.addEventListener("mouseup", up, true);
  mount.addEventListener("mouseleave", reset);
  const resize = terminal.onResize(reset);
  const scroll = terminal.onScroll(reset);
  return { dispose() {
    reset(); resize.dispose(); scroll.dispose();
    mount.removeEventListener("mousedown", down, true);
    mount.removeEventListener("mouseup", up, true);
    mount.removeEventListener("mouseleave", reset);
    if (terminal.options.linkHandler === handler) terminal.options.linkHandler = previous;
  } };
}
