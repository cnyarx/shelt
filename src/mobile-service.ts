import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HerdrTarget } from "./targets.ts";
import { herdrPaneEnvironment, type LaunchTarget } from "./launch.ts";
import { validPane, NATIVE_EVENTS } from "./mobile-model.ts";

export class NativeControlConnection {
  private closed = false;
  private requests = new Set<() => void>();
  private subscription: (() => void) | undefined;
  constructor(private launch: LaunchTarget, private target: HerdrTarget | null, private send: (line: string) => void, private disconnect: () => void, private env = process.env) {}
  close(): void {
    this.closed = true;
    for (const cancel of [...this.requests]) cancel();
  }
  request(raw: string): boolean {
    const line = nativeRequest(raw);
    if (!line || this.closed || this.requests.size >= 16) return false;
    const request = JSON.parse(line), subscribe = request.method === "events.subscribe";
    if (subscribe) this.subscription?.();
    let done = false, replied = false, buffer = "";
    const decoder = new StringDecoder("utf8");
    let release = () => {};
    const cancel = () => {
      if (done) return;
      done = true; clearTimeout(timer); this.requests.delete(cancel);
      if (this.subscription === cancel) this.subscription = undefined;
      release();
    };
    const failed = () => {
      if (done) return;
      cancel();
      if (this.closed) return;
      if (subscribe && replied) this.disconnect();
      else this.send(JSON.stringify({ id: request.id, error: { code: "herdr_unavailable", message: "Herdr control unavailable" } }));
    };
    const timer = setTimeout(failed, 8000);
    this.requests.add(cancel);
    if (subscribe) this.subscription = cancel;
    const receive = (chunk: Buffer) => {
      if (done) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { failed(); return; }
      let end: number;
      while (!done && (end = buffer.indexOf("\n")) >= 0) {
        const result = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!result) continue;
        replied = true; clearTimeout(timer); this.send(result);
        if (!subscribe) cancel();
      }
    };
    if (this.target) {
      const args = nativeBridgeCommand(this.launch, this.target);
      const env = herdrPaneEnvironment(this.env); delete env.HERDR_ENV; delete env.HERDR_SOCKET_PATH;
      const child = spawn(args[0]!, args.slice(1), { env, stdio: ["pipe", "pipe", "ignore"] });
      release = () => { child.stdin.destroy(); child.stdout.destroy(); child.kill(); };
      child.stdout.on("data", receive); child.stdout.on("end", failed); child.stdout.on("error", failed);
      child.stdin.on("error", failed); child.on("error", failed); child.on("exit", failed);
      child.stdin.write(line);
    } else {
      const path = this.env.HERDR_SOCKET_PATH || join(this.env.HERDR_CONFIG_PATH ? dirname(this.env.HERDR_CONFIG_PATH) : join(this.env.XDG_CONFIG_HOME || join(this.env.HOME || ".", ".config"), "herdr"), "herdr.sock");
      const socket = createConnection(path);
      release = () => socket.destroy();
      socket.on("connect", () => socket.write(line)); socket.on("data", receive);
      socket.on("error", failed); socket.on("end", failed); socket.on("close", failed);
    }
    return true;
  }
}

export function nativeBridgeCommand(launch: LaunchTarget, target: HerdrTarget | null): string[] {
  if (!target) return [launch.command, "remote-api-bridge"];
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", target.remote,
    `PATH="$HOME/bin:$HOME/.local/bin:$PATH"; export PATH; exec herdr ${target.session ? `--session ${quote(target.session)} ` : ""}remote-api-bridge`];
}

export function nativeRequest(raw: string): string | null {
  if (raw.length > 65536) return null;
  let request: any;
  try { request = JSON.parse(raw); } catch { return null; }
  if (!request || typeof request.id !== "string" || !/^[A-Za-z0-9:._-]{1,80}$/.test(request.id)) return null;
  const params = request.params ?? {};
  let body: object;
  switch (request.method) {
    case "ping": case "session.snapshot": body = {}; break;
    case "agent.focus":
      if (typeof params.target !== "string" || !validPane(params.target)) return null;
      body = { target: params.target }; break;
    case "pane.focus":
      if (typeof params.pane_id !== "string" || !validPane(params.pane_id)) return null;
      body = { pane_id: params.pane_id }; break;
    case "pane.zoom":
      if (typeof params.pane_id !== "string" || !validPane(params.pane_id) || !["toggle", "on", "off"].includes(params.mode)) return null;
      body = { pane_id: params.pane_id, mode: params.mode }; break;
    case "events.subscribe": {
      if (!Array.isArray(params.subscriptions) || params.subscriptions.length > 1024) return null;
      const subscriptions = [];
      for (const item of params.subscriptions) {
        if (!item || typeof item.type !== "string") return null;
        if (item.type === "pane.agent_status_changed" && typeof item.pane_id === "string" && validPane(item.pane_id)) subscriptions.push({ type: item.type, pane_id: item.pane_id });
        else if ((NATIVE_EVENTS as readonly string[]).includes(item.type)) subscriptions.push({ type: item.type });
        else return null;
      }
      body = { subscriptions }; break;
    }
    default: return null;
  }
  return JSON.stringify({ id: request.id, method: request.method, params: body }) + "\n";
}
