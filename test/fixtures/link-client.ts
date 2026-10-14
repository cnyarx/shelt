import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { installOscLinkHandling } from "../../src/osc-links.ts";
import "@xterm/xterm/css/xterm.css";

const mount = document.getElementById("terminal")!;
const opened: string[] = [];
const sent: string[] = [];
const events: string[] = [];
const target = `${location.origin}/review/30457150?source=osc8`;
const terminal = new Terminal({
  cols: 80, rows: 12, scrollback: 0, allowProposedApi: true, fontSize: 16,
});
terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = "11";
terminal.open(mount); terminal.loadAddon(new CanvasAddon());
installOscLinkHandling(terminal, mount, (url) => { opened.push(url); if ((window as any).linkTest.realOpen) window.open(url, "_blank", "noopener,noreferrer"); });
terminal.onData((data) => sent.push(data));
terminal.onBinary((data) => sent.push(data));
function redraw(uri = target) {
  return new Promise<void>((resolve) => terminal.write(`\x1b[H\x1b[0m\x1b[2K\x1b[34;4m\x1b]8;;${uri}\x1b\\30457150\x1b]8;;\x1b\\\x1b[0m  plain ID: 30457150\r\n\x1b[2KCtrl-click or click the linked ID above.\r\n`, resolve));
}
(window as any).linkTest = { terminal, opened, sent, events, target, redraw, realOpen: false };
await new Promise<void>((resolve) => terminal.write("\x1b[?1049h\x1b[?1003h\x1b[?1006h", resolve));
await redraw();
