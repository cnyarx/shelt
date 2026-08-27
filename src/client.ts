import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { decodeOsc52 } from "./clipboard.ts";
import { createSemanticAnsiState, normalizeSemanticAnsiChunk, resetSemanticAnsiState } from "./ansi.ts";
import { uploadFileNameHeader } from "./security.ts";

const mount = document.getElementById("terminal");
if (!mount) throw new Error("terminal mount missing");

const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 14,
  allowProposedApi: true,
  scrollback: 0,
  theme: { background: "#000000" },
});
const fit = new FitAddon();
const unicode11 = new Unicode11Addon();
terminal.loadAddon(fit);
terminal.loadAddon(unicode11);
terminal.unicode.activeVersion = "11";
terminal.open(mount);
terminal.loadAddon(new CanvasAddon());
fit.fit();
terminal.focus();

const scheme = location.protocol === "https:" ? "wss" : "ws";
let socket: WebSocket | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const semanticAnsi = createSemanticAnsiState();

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function showManualCopy(text: string) {
  document.getElementById("manual-copy")?.remove();
  const dialog = document.createElement("section");
  dialog.id = "manual-copy";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Manual clipboard copy");

  const message = document.createElement("p");
  message.textContent = "Browser clipboard access failed. Copy the text below manually:";
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    dialog.remove();
    terminal.focus();
  });

  dialog.append(message, textarea, close);
  document.body.append(dialog);
  textarea.focus();
  textarea.select();
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  if (fallbackCopy(text)) return;
  showManualCopy(text);
}

terminal.parser.registerOscHandler(52, async (data) => {
  const clipboard = decodeOsc52(data);
  if (!clipboard.ok) {
    terminal.write(`\r\n\x1b[31mClipboard copy rejected: ${clipboard.error}.\x1b[0m\r\n`);
    return true;
  }
  await writeClipboard(clipboard.text);
  return true;
});

function connect() {
  const nextSocket = new WebSocket(`${scheme}://${location.host}/ws?cols=${terminal.cols}&rows=${terminal.rows}`);
  socket = nextSocket;
  nextSocket.binaryType = "arraybuffer";
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;
    if (event.data instanceof ArrayBuffer) {
      for (const frame of normalizeSemanticAnsiChunk(semanticAnsi, new Uint8Array(event.data))) terminal.write(frame);
    } else {
      terminal.write(event.data);
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    terminal.write("\r\n\x1b[31mShelt disconnected. Reload to reconnect.\x1b[0m\r\n");
  });
}

function send(message: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function scheduleResize() {
  const dimensions = fit.proposeDimensions();
  if (!dimensions || (dimensions.cols === terminal.cols && dimensions.rows === terminal.rows)) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    const finalDimensions = fit.proposeDimensions();
    if (!finalDimensions || (finalDimensions.cols === terminal.cols && finalDimensions.rows === terminal.rows)) return;

    const previousSocket = socket;
    socket = undefined;
    previousSocket?.close();
    fit.fit();
    resetSemanticAnsiState(semanticAnsi);
    terminal.reset();
    connect();
  }, 150);
}

terminal.onData((data) => send({ type: "input", data }));
new ResizeObserver(scheduleResize).observe(mount);

async function uploadImage(file: File) {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": file.type, "X-File-Name": uploadFileNameHeader(file.name) },
    body: file,
  });
  if (!response.ok) throw new Error(await response.text());
  const result = (await response.json()) as { ok: true; path: string };
  send({ type: "paste-path", path: result.path });
}

document.addEventListener("paste", (event) => {
  for (const item of event.clipboardData?.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        void uploadImage(file).catch((error) => terminal.write(`\r\n\x1b[31mImage paste failed: ${String(error)}\x1b[0m\r\n`));
        return;
      }
    }
  }
}, true);

window.addEventListener("focus", () => terminal.focus());
connect();
