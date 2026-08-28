import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AuthStore,
  MAX_AUTH_BODY_BYTES,
  expiredSessionCookie,
  passwordError,
  sessionCookie,
} from "./auth.ts";
import { embeddedAssets } from "./generated-assets.ts";
import { loginShellFromPasswd, resolveLaunch } from "./launch.ts";
import {
  MAX_IMAGE_BYTES,
  allowedHost,
  allowedOrigin,
  bracketedPaste,
  hasImageSignature,
  imageExtension,
  safeUploadStem,
} from "./security.ts";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const host = process.env.SHELT_HOST || "127.0.0.1";
const port = Number(process.env.SHELT_PORT || "8790");
const stateDir = resolve(
  process.env.SHELT_STATE_DIR || join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local/state"), "shelt"),
);
const publicHosts = new Set(
  (process.env.SHELT_PUBLIC_HOSTS || `${host}:${port},localhost:${port}`)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const allowedOrigins = (process.env.SHELT_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const uploadDir = resolve(
  process.env.SHELT_UPLOAD_DIR ||
    join(process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME || ".", ".local/state/herdr/plugins/shelt"), "uploads"),
);
const auth = new AuthStore(join(stateDir, "auth.json"), process.env.SHELT_SECURE_COOKIE === "true");
await auth.load();
let passwdShell: string | null = null;
if (typeof process.getuid === "function") {
  try {
    passwdShell = loginShellFromPasswd(await readFile("/etc/passwd", "utf8"), process.getuid());
  } catch {}
}
const launch = resolveLaunch({ env: process.env, which: Bun.which, passwdShell });

await mkdir(uploadDir, { recursive: true, mode: 0o700 });
await chmod(uploadDir, 0o700);

let activeSocket: Bun.ServerWebSocket<SessionData> | null = null;
let activeProcess: Bun.Subprocess | null = null;
let failedLogins = 0;
const uploadedPaths = new Set<string>();

type SessionData = { terminal: Bun.Terminal | null; process: Bun.Subprocess | null; cols: number; rows: number };
type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "paste-path"; path: string };
type AuthRequest = { password?: unknown; remember?: unknown };

function response(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return response(JSON.stringify(body), status, { "Content-Type": "application/json", ...headers });
}

async function authBody(req: Request): Promise<AuthRequest | null> {
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > MAX_AUTH_BODY_BYTES) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_AUTH_BODY_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as AuthRequest;
  } catch {
    return null;
  }
}

function authenticated(req: Request): boolean {
  return auth.authenticated(req.headers.get("cookie"));
}

async function staticFile(pathname: string): Promise<Response> {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "style.css", "client.css", "client.js", "favicon.png", "favicon-16.png", "favicon-32.png", "favicon-64.png"]).has(file)) return response("Not found", 404);
  const type = file.endsWith(".html")
    ? "text/html; charset=utf-8"
    : file.endsWith(".css")
      ? "text/css; charset=utf-8"
      : file.endsWith(".png")
        ? "image/png"
        : "text/javascript; charset=utf-8";
  const embedded = embeddedAssets[file as keyof typeof embeddedAssets];
  if (embedded.length > 0) return response(embedded, 200, { "Content-Type": type, "Cache-Control": "no-cache" });
  try {
    return response(await readFile(join(dist, file)), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
  } catch {
    return response("Build missing. Run bun run build.", 503);
  }
}

const server = Bun.serve<SessionData>({
  hostname: host,
  port,
  maxRequestBodySize: MAX_IMAGE_BYTES,
  async fetch(req, server) {
    const url = new URL(req.url);
    const requestHost = (req.headers.get("host") || "").toLowerCase();
    if (!allowedHost(requestHost, [...publicHosts])) return response("Forbidden host", 403);

    if (url.pathname === "/api/auth/status" && req.method === "GET") {
      return json({ setupRequired: auth.setupRequired(), authenticated: authenticated(req) });
    }

    if (url.pathname === "/api/auth/setup" && req.method === "POST") {
      if (!allowedOrigin(req.headers.get("origin"), requestHost, allowedOrigins)) return response("Cross-origin rejected", 403);
      const body = await authBody(req);
      if (!body) return json({ error: "Invalid request" }, 400);
      const error = passwordError(body.password);
      if (error) return json({ error }, 400);
      try {
        if (!(await auth.setup(body.password as string))) return json({ error: "Password is already configured" }, 409);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return json({ error: "Password is already configured" }, 409);
        throw cause;
      }
      const remember = body.remember === true;
      const token = auth.createSession(remember);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, remember, auth.secureCookie) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!allowedOrigin(req.headers.get("origin"), requestHost, allowedOrigins)) return response("Cross-origin rejected", 403);
      const body = await authBody(req);
      if (!body || passwordError(body.password)) return json({ error: "Invalid password" }, 401);
      if (!(await auth.verify(body.password as string))) {
        failedLogins = Math.min(failedLogins + 1, 6);
        await Bun.sleep(Math.min(2000, 100 * 2 ** (failedLogins - 1)));
        return json({ error: "Invalid password" }, 401);
      }
      failedLogins = 0;
      const remember = body.remember === true;
      const token = auth.createSession(remember);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, remember, auth.secureCookie) });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      if (!allowedOrigin(req.headers.get("origin"), requestHost, allowedOrigins)) return response("Cross-origin rejected", 403);
      auth.revoke(req.headers.get("cookie"));
      return json({ ok: true }, 200, { "Set-Cookie": expiredSessionCookie(auth.secureCookie) });
    }

    if (url.pathname === "/ws") {
      if (!allowedOrigin(req.headers.get("origin"), requestHost, allowedOrigins)) return response("Cross-origin rejected", 403);
      if (!authenticated(req)) return response("Authentication required", 401);
      const cols = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("cols") || "120", 10) || 120));
      const rows = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("rows") || "40", 10) || 40));
      if (!server.upgrade(req, { data: { terminal: null, process: null, cols, rows } })) return response("Upgrade failed", 400);
      return;
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      if (!allowedOrigin(req.headers.get("origin"), requestHost, allowedOrigins)) return response("Cross-origin rejected", 403);
      if (!authenticated(req)) return response("Authentication required", 401);
      const contentType = (req.headers.get("content-type") || "").split(";", 1)[0]!.trim();
      const extension = imageExtension(contentType);
      if (!extension) return response("Unsupported image type", 415);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return response("Invalid image size", 413);
      if (!hasImageSignature(bytes, extension)) return response("Image signature mismatch", 415);
      const stem = safeUploadStem(req.headers.get("x-file-name"));
      const path = join(uploadDir, `${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.write(bytes);
      } finally {
        await file.close();
      }
      await chmod(path, 0o600);
      uploadedPaths.add(path);
      return json({ ok: true, path });
    }

    if (url.pathname === "/health" && req.method === "GET") return json({ ok: true });
    if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) return staticFile(url.pathname);
    return response("Not found", 404);
  },
  websocket: {
    open(ws) {
      activeSocket?.close(1012, "Replaced by a newer Shelt controller");
      activeProcess?.kill("SIGKILL");
      const env = { ...process.env };
      delete env.HERDR_ENV;
      delete env.HERDR_PANE_ID;
      delete env.HERDR_WORKSPACE_ID;
      delete env.HERDR_TAB_ID;
      delete env.HERDR_CWD;
      Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "shelt" });
      delete env.HERDR_RENDER_ENCODING;
      const terminal = new Bun.Terminal({
        name: "xterm-256color",
        cols: ws.data.cols,
        rows: ws.data.rows,
        data: (_terminal, data) => ws.sendBinary(data),
      });
      const child = Bun.spawn([launch.command, ...launch.args], {
        cwd: process.env.HOME || process.cwd(),
        env,
        terminal,
        onExit(_process, exitCode) {
          if (activeProcess === child) activeProcess = null;
          if (!terminal.closed) terminal.close();
          ws.close(1011, `${launch.mode === "herdr" ? "Herdr" : "Shell"} exited (${exitCode})`);
        },
      });
      ws.data.terminal = terminal;
      ws.data.process = child;
      activeSocket = ws;
      activeProcess = child;
    },
    message(ws, raw) {
      if (ws !== activeSocket || !ws.data.terminal) return;
      try {
        const message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")) as ClientMessage;
        if (message.type === "input" && typeof message.data === "string") {
          ws.data.terminal.write(message.data);
        } else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0 && message.cols <= 1000 && message.rows <= 500) {
          ws.data.terminal.resize(message.cols, message.rows);
        } else if (message.type === "paste-path" && typeof message.path === "string" && uploadedPaths.delete(message.path)) {
          ws.data.terminal.write(bracketedPaste(message.path));
        }
      } catch {
        ws.close(1003, "Invalid message");
      }
    },
    close(ws) {
      if (activeSocket === ws) activeSocket = null;
      if (ws.data.process) {
        ws.data.process.kill("SIGKILL");
        if (activeProcess === ws.data.process) activeProcess = null;
      }
      if (ws.data.terminal && !ws.data.terminal.closed) ws.data.terminal.close();
    },
  },
});

console.log(`Shelt listening on http://${server.hostname}:${server.port} (${launch.mode}: ${launch.command})`);
