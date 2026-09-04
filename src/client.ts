import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createSemanticAnsiState, normalizeSemanticAnsiChunk, resetSemanticAnsiState } from "./ansi.ts";
import { decodeOsc52 } from "./clipboard.ts";
import {
  createDocumentLinkIndicatorLayer,
  createDocumentLinkProvider,
  registerDocumentLinkMouseActivation,
} from "./document-links.ts";
import { uploadFileNameHeader } from "./security.ts";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Shelt UI mount missing: ${id}`);
  return element as T;
}

const authMount = requiredElement<HTMLElement>("auth");
const form = requiredElement<HTMLFormElement>("auth-form");
const title = requiredElement<HTMLElement>("auth-title");
const description = requiredElement<HTMLElement>("auth-description");
const password = requiredElement<HTMLInputElement>("password");
const confirmRow = requiredElement<HTMLElement>("confirm-row");
const confirmPassword = requiredElement<HTMLInputElement>("confirm-password");
const remember = requiredElement<HTMLInputElement>("remember");
const errorMessage = requiredElement<HTMLElement>("auth-error");
const submit = requiredElement<HTMLButtonElement>("auth-submit");
const mount = requiredElement<HTMLElement>("terminal");

const scheme = location.protocol === "https:" ? "wss" : "ws";
const semanticAnsi = createSemanticAnsiState();
let setupRequired = false;
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let socket: WebSocket | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

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
    terminal?.focus();
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

async function authStatus(): Promise<{ setupRequired: boolean; authenticated: boolean }> {
  const response = await fetch("/api/auth/status", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Unable to check authentication status");
  return response.json() as Promise<{ setupRequired: boolean; authenticated: boolean }>;
}

function showAuth(required: boolean, message = "") {
  setupRequired = required;
  socket?.close();
  socket = undefined;
  mount.hidden = true;
  authMount.hidden = false;
  title.textContent = required ? "Set up Shelt" : "Unlock Shelt";
  description.textContent = required
    ? "Create the password required to open this terminal."
    : "Enter your password to open the terminal.";
  password.autocomplete = required ? "new-password" : "current-password";
  confirmRow.hidden = !required;
  confirmPassword.hidden = !required;
  confirmPassword.required = required;
  submit.textContent = required ? "Set password" : "Unlock";
  errorMessage.textContent = message;
  form.reset();
  password.focus();
}

function connect() {
  if (!terminal) return;
  const nextSocket = new WebSocket(`${scheme}://${location.host}/ws?cols=${terminal.cols}&rows=${terminal.rows}`);
  socket = nextSocket;
  nextSocket.binaryType = "arraybuffer";
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket || !terminal) return;
    if (event.data instanceof ArrayBuffer) {
      for (const frame of normalizeSemanticAnsiChunk(semanticAnsi, new Uint8Array(event.data))) terminal.write(frame);
    } else {
      terminal.write(event.data);
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = undefined;
    void authStatus().then((status) => {
      if (!status.authenticated) showAuth(status.setupRequired, "Your session expired. Enter your password again.");
      else terminal?.write("\r\n\x1b[31mShelt disconnected. Reload to reconnect.\x1b[0m\r\n");
    }).catch(() => terminal?.write("\r\n\x1b[31mShelt disconnected. Reload to reconnect.\x1b[0m\r\n"));
  });
}

function send(message: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function scheduleResize() {
  if (!terminal || !fit) return;
  const dimensions = fit.proposeDimensions();
  if (!dimensions || (dimensions.cols === terminal.cols && dimensions.rows === terminal.rows)) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    if (!terminal || !fit) return;
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

async function uploadImage(file: File) {
  const response = await fetch("/api/upload", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": file.type, "X-File-Name": uploadFileNameHeader(file.name) },
    body: file,
  });
  if (response.status === 401) {
    const status = await authStatus();
    showAuth(status.setupRequired, "Your session expired. Enter your password again.");
    return;
  }
  if (!response.ok) throw new Error(await response.text());
  const result = (await response.json()) as { ok: true; path: string };
  send({ type: "paste-path", path: result.path });
}

function openLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function startTerminal() {
  authMount.hidden = true;
  mount.hidden = false;
  if (terminal) {
    fit?.fit();
    terminal.focus();
    connect();
    return;
  }
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 14,
    allowProposedApi: true,
    scrollback: 0,
    theme: { background: "#000000" },
    linkHandler: {
      activate: (_event, url) => openLink(url),
    },
  });
  fit = new FitAddon();
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(fit);
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";
  terminal.open(mount);
  terminal.loadAddon(new CanvasAddon());
  terminal.loadAddon(new WebLinksAddon((_event, url) => openLink(url), {
    hover: (_event, url) => { mount.title = url; },
    leave: () => { mount.removeAttribute("title"); },
  }));
  terminal.registerLinkProvider(createDocumentLinkProvider(terminal, mount, openLink));
  registerDocumentLinkMouseActivation(terminal, mount, openLink);
  createDocumentLinkIndicatorLayer(terminal, mount);
  terminal.parser.registerOscHandler(52, async (data) => {
    const clipboard = decodeOsc52(data);
    if (!clipboard.ok) {
      terminal?.write(`\r\n\x1b[31mClipboard copy rejected: ${clipboard.error}.\x1b[0m\r\n`);
      return true;
    }
    await writeClipboard(clipboard.text);
    return true;
  });
  terminal.onData((data) => send({ type: "input", data }));
  new ResizeObserver(scheduleResize).observe(mount);
  fit.fit();
  terminal.focus();
  connect();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorMessage.textContent = "";
  if (setupRequired && password.value !== confirmPassword.value) {
    errorMessage.textContent = "Passwords do not match.";
    confirmPassword.focus();
    return;
  }
  submit.disabled = true;
  const endpoint = setupRequired ? "/api/auth/setup" : "/api/auth/login";
  void fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password.value, remember: remember.checked }),
  }).then(async (response) => {
    if (!response.ok) {
      const result = await response.json().catch(() => ({ error: "Authentication failed" })) as { error?: string };
      throw new Error(result.error || "Authentication failed");
    }
    password.value = "";
    confirmPassword.value = "";
    startTerminal();
  }).catch((error) => {
    errorMessage.textContent = error instanceof Error ? error.message : "Authentication failed";
    password.select();
  }).finally(() => {
    submit.disabled = false;
  });
});

document.addEventListener("paste", (event) => {
  if (mount.hidden) return;
  for (const item of event.clipboardData?.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        void uploadImage(file).catch((error) => terminal?.write(`\r\n\x1b[31mImage paste failed: ${String(error)}\x1b[0m\r\n`));
        return;
      }
    }
  }
}, true);

window.addEventListener("focus", () => {
  if (!mount.hidden) terminal?.focus();
});

void authStatus().then((status) => {
  if (status.authenticated) startTerminal();
  else showAuth(status.setupRequired);
}).catch((error) => showAuth(false, error instanceof Error ? error.message : "Unable to load Shelt"));
