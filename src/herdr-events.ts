import { createConnection } from "node:net";
import { join } from "node:path";
import type { LaunchTarget } from "./launch.ts";

export type HerdrAgent = { paneId: string; status: string; title: string; agent: string; cwd: string };
export type HerdrEventMessage =
  | { type: "snapshot"; agents: HerdrAgent[] }
  | { type: "status"; paneId: string; status: string; title: string; agent: string }
  | { type: "removed"; paneId: string };

export function herdrSocketPath(env: Record<string, string | undefined>): string {
  return env.HERDR_SOCKET_PATH || join(env.HOME || ".", ".config/herdr/herdr.sock");
}

type ListAgent = {
  pane_id: string;
  agent_status: string;
  terminal_title_stripped?: string;
  agent?: string | null;
  cwd?: string;
};

type StatusEvent = { agent_status: string; pane_id: string; agent?: string | null };

const GLOBAL_SUBSCRIPTIONS = [{ type: "pane.agent_detected" }, { type: "pane.closed" }];

/** Event-stream bridge to the local Herdr server socket. Purely event driven: one
 * persistent connection subscribes to agent status changes; no polling anywhere. */
export class HerdrEvents {
  private readonly path: string;
  private readonly available: boolean;
  private listeners = new Set<(message: HerdrEventMessage) => void>();
  private agents = new Map<string, HerdrAgent>();
  private socket: ReturnType<typeof createConnection> | null = null;
  private buffer = "";
  private pending = new Map<string, (result: Record<string, unknown>) => void>();
  private seq = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelay = 1000;
  private started = false;

  constructor(launch: LaunchTarget, env: Record<string, string | undefined>) {
    this.available = launch.mode === "herdr";
    this.path = herdrSocketPath(env);
  }

  subscribe(listener: (message: HerdrEventMessage) => void): () => void {
    if (!this.available) return () => {};
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): HerdrAgent[] {
    return [...this.agents.values()].map((agent) => ({ ...agent }));
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    this.cleanup();
    const socket = createConnection(this.path);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => { void this.initialize().catch(() => this.scheduleRestart()); });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    const failure = () => { if (this.socket === socket) this.scheduleRestart(); };
    socket.on("error", failure);
    socket.on("close", failure);
  }

  private cleanup(): void {
    this.buffer = "";
    for (const resolve of this.pending.values()) resolve({ type: "error" });
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private scheduleRestart(): void {
    if (!this.started || this.restartTimer) return;
    this.cleanup();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.connect();
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
  }

  private send(method: string, params: Record<string, unknown>, onResult: (result: Record<string, unknown>) => void): void {
    const socket = this.socket;
    if (!socket) throw new Error("not connected");
    const id = `shelt:${method}:${++this.seq}`;
    this.pending.set(id, onResult);
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const fail = () => { if (!settled) { settled = true; reject(new Error("bridge initialization failed")); } };
      this.send("ping", {}, () => {
        this.send("agent.list", {}, (result) => {
          const agents = Array.isArray(result.agents) ? result.agents as ListAgent[] : [];
          this.refreshAgents(agents);
          this.broadcast({ type: "snapshot", agents: this.snapshot() });
          this.send("events.subscribe", { subscriptions: [...GLOBAL_SUBSCRIPTIONS, ...agents.map((agent) => ({ type: "pane.agent_status_changed", pane_id: agent.pane_id }))] }, done);
          setTimeout(fail, 10_000);
        });
        setTimeout(fail, 10_000);
      });
      setTimeout(fail, 10_000);
    });
  }

  private handleLine(line: string): void {
    let message: { id?: string; result?: Record<string, unknown>; event?: string; data?: Record<string, unknown> };
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.result !== undefined) {
      const resolve = this.pending.get(message.id);
      if (resolve) { this.pending.delete(message.id); resolve(message.result); }
      return;
    }
    if (message.event === "pane.agent_status_changed" && message.data) {
      const data = message.data as unknown as StatusEvent;
      if (!data.pane_id || !data.agent_status) return;
      const previous = this.agents.get(data.pane_id);
      const next: HerdrAgent = {
        paneId: data.pane_id,
        status: data.agent_status,
        title: previous?.title || (data.agent ? String(data.agent) : data.pane_id),
        agent: data.agent ? String(data.agent) : previous?.agent || "",
        cwd: previous?.cwd || "",
      };
      this.agents.set(data.pane_id, next);
      this.restartDelay = 1000;
      this.broadcast({ type: "status", paneId: next.paneId, status: next.status, title: next.title, agent: next.agent });
      return;
    }
    if (message.event === "pane.agent_detected") {
      // A new agent pane exists; re-list once (cheap local call) to pick up its
      // title and subscribe to its future status changes.
      this.send("agent.list", {}, (result) => {
        const agents = Array.isArray(result.agents) ? result.agents as ListAgent[] : [];
        const known = new Set(this.agents.keys());
        this.refreshAgents(agents);
        this.broadcast({ type: "snapshot", agents: this.snapshot() });
        const fresh = agents.filter((agent) => !known.has(agent.pane_id));
        if (fresh.length > 0) {
          this.send("events.subscribe", { subscriptions: fresh.map((agent) => ({ type: "pane.agent_status_changed", pane_id: agent.pane_id })) }, () => {});
        }
      });
      return;
    }
    if (message.event === "pane.closed" && message.data) {
      const paneId = message.data.pane_id;
      if (typeof paneId !== "string") return;
      if (this.agents.delete(paneId)) this.broadcast({ type: "removed", paneId });
    }
  }

  private refreshAgents(list: ListAgent[]): void {
    this.agents = new Map(list.map((agent) => ({
      paneId: agent.pane_id,
      status: agent.agent_status,
      title: agent.terminal_title_stripped || (agent.agent ? String(agent.agent) : agent.pane_id),
      agent: agent.agent ? String(agent.agent) : "",
      cwd: agent.cwd || "",
    })).map((agent) => [agent.paneId, agent]));
  }

  private broadcast(message: HerdrEventMessage): void {
    for (const listener of [...this.listeners]) {
      try { listener(message); } catch { /* listener errors must not break the bridge */ }
    }
  }
}
