import { expect, test } from "bun:test";
import type { IBufferRange, ILinkHandler, Terminal } from "@xterm/xterm";
import { installOscLinkHandling } from "../src/osc-links.ts";

const url = "https://example.com/reviews/30457150?tab=changes#discussion";
const range: IBufferRange = { start: { x: 11, y: 6 }, end: { x: 18, y: 6 } };

function fixture() {
  const listeners = new Map<string, (event: MouseEvent) => void>();
  const opened: string[] = [];
  const hooks: Record<string, () => void> = {};
  const terminal = {
    cols: 80, rows: 10, options: { linkHandler: undefined as ILinkHandler | undefined },
    buffer: { active: { viewportY: 5 } },
    onResize: (fn: () => void) => { hooks.resize = fn; return { dispose() {} }; },
    onScroll: (fn: () => void) => { hooks.scroll = fn; return { dispose() {} }; },
  };
  const mount = {
    title: "", removeAttribute() { this.title = ""; },
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 20, top: 40, right: 820, bottom: 240, width: 800, height: 200 }) }),
    addEventListener: (name: string, handler: (event: MouseEvent) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const disposable = installOscLinkHandling(terminal as unknown as Terminal, mount as unknown as HTMLElement, (url) => opened.push(url));
  const event = (extra: Partial<MouseEvent> = {}) => {
    const signals = { prevented: false, stopped: false };
    return { button: 0, clientX: 125, clientY: 50, shiftKey: false, preventDefault: () => { signals.prevented = true; }, stopImmediatePropagation: () => { signals.stopped = true; }, ...extra, signals } as unknown as MouseEvent & { signals: typeof signals };
  };
  const handler = terminal.options.linkHandler!;
  const hover = (target = url, area = range) => handler.hover!(event(), target, area);
  return { opened, listeners, hooks, mount, handler, terminal, disposable, event, hover };
}

test("OSC8 click survives a repaint replacing the link object, including Ctrl and Meta", () => {
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const f = fixture(); f.hover();
    const down = f.event(modifiers); f.listeners.get("mousedown")!(down);
    f.handler.leave!(down, url, range);
    f.hover(url, { start: { ...range.start }, end: { ...range.end } });
    const up = f.event(modifiers); f.listeners.get("mouseup")!(up);
    expect(f.opened).toEqual([url]);
    expect(down.signals).toEqual({ prevented: true, stopped: true });
    expect(up.signals).toEqual({ prevented: true, stopped: true });
    f.disposable.dispose();
  }
});

test("does not open a different target, removed link or moved range after repaint", () => {
  for (const change of ["url", "remove", "move"]) {
    const f = fixture(); f.hover(); f.listeners.get("mousedown")!(f.event());
    f.handler.leave!(f.event(), url, range);
    if (change === "url") f.hover("https://example.com/different");
    if (change === "move") f.hover(url, { start: { x: 12, y: 6 }, end: { x: 19, y: 6 } });
    f.listeners.get("mouseup")!(f.event());
    expect(f.opened).toEqual([]);
    f.disposable.dispose();
  }
});

test("plain numeric text is not made into a guessed URL", () => {
  const f = fixture();
  const down = f.event(); f.listeners.get("mousedown")!(down); f.listeners.get("mouseup")!(f.event());
  expect(f.opened).toEqual([]); expect(down.signals.stopped).toBe(false);
});

test("dragging outside, Shift selection and non-left buttons do not activate links", () => {
  const f = fixture(); f.hover();
  f.listeners.get("mousedown")!(f.event()); f.listeners.get("mouseup")!(f.event({ clientX: 310 }));
  expect(f.opened).toEqual([]);
  for (const extra of [{ shiftKey: true }, { button: 1 }, { button: 2 }]) {
    const down = f.event(extra); f.listeners.get("mousedown")!(down); f.listeners.get("mouseup")!(f.event(extra));
    f.handler.activate(f.event(extra), url, range);
    expect(down.signals.stopped).toBe(false);
  }
  expect(f.opened).toEqual([]);
});

test("leaving the terminal, scrolling and resizing invalidate a pending click", () => {
  for (const change of ["mouseleave", "resize", "scroll"]) {
    const f = fixture(); f.hover(); f.listeners.get("mousedown")!(f.event());
    if (change === "mouseleave") f.listeners.get(change)!(f.event()); else f.hooks[change]!();
    f.hover(); f.listeners.get("mouseup")!(f.event()); expect(f.opened).toEqual([]);
  }
});

test("keeps http(s) restrictions and never handles script or file URLs", () => {
  for (const target of ["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "30457150"]) {
    const f = fixture(); f.hover(target); f.listeners.get("mousedown")!(f.event()); f.listeners.get("mouseup")!(f.event());
    f.handler.activate(f.event(), target, range); expect(f.opened).toEqual([]);
  }
});

test("disposal removes listeners and restores the previous link handler", () => {
  const f = fixture(); f.hover(); expect(f.mount.title).toBe(url);
  f.disposable.dispose(); expect(f.listeners.size).toBe(0); expect(f.terminal.options.linkHandler).toBeUndefined(); expect(f.mount.title).toBe("");
});
