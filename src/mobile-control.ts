import { NATIVE_EVENTS, type NativeSnapshot } from "./mobile-model.ts";

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export class MobileControl {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private snapshotRequest: Promise<void> | null = null;
  private snapshotAgain = false;
  private subscribed = new Set<string>();
  private lastFocus: string | null = null;
  private pendingFocus: string | null = null;
  private aligning = false;
  ready = false;
  constructor(private onSnapshot: (value: NativeSnapshot) => void, private onUnavailable: () => void) {}
  connect(target: string): void {
    this.close();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/api/mobile/control?target=${encodeURIComponent(target)}`);
    this.socket = socket;
    socket.addEventListener("message", event => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let value: any;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value.event) {
        void this.refresh().catch(() => { if (this.socket === socket) this.onUnavailable(); });
      } else if (value.id) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(value.error.message || "Herdr unavailable"));
        else pending.resolve(value.result);
      }
    });
    socket.addEventListener("open", () => {
      void (async () => {
        await this.request("ping", {});
        await this.request("events.subscribe", { subscriptions: NATIVE_EVENTS.map(type => ({ type })) });
        if (this.socket !== socket) return;
        this.ready = true;
        await this.refresh();
      })().catch(() => { if (this.socket === socket) { this.close(); this.onUnavailable(); } });
    });
    socket.addEventListener("close", () => { if (this.socket === socket) { this.close(); this.onUnavailable(); } });
    socket.addEventListener("error", () => { if (this.socket === socket) this.onUnavailable(); });
  }
  close(): void {
    const old = this.socket; this.socket = null; this.ready = false; old?.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Herdr disconnected")); }
    this.pending.clear(); this.subscribed.clear(); this.snapshotRequest = null; this.snapshotAgain = false;
    this.lastFocus = null; this.pendingFocus = null; this.aligning = false;
  }
  private request(method: string, params: object): Promise<any> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Herdr disconnected"));
    const id = `shelt-ui:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Herdr request timed out")); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  refresh(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    if (this.snapshotRequest) { this.snapshotAgain = true; return this.snapshotRequest; }
    const socket = this.socket;
    const promise = (async () => {
      do {
        this.snapshotAgain = false;
        const result = await this.request("session.snapshot", {});
        if (this.socket !== socket) return;
        const snapshot = result.snapshot as NativeSnapshot;
        if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.workspaces)) throw new Error("Invalid Herdr snapshot");
        this.onSnapshot(snapshot);
        const focus = snapshot.focused_pane_id ?? null;
        if (this.lastFocus === null) this.lastFocus = focus;
        else if (focus && focus !== this.lastFocus) {
          this.lastFocus = focus;
          this.alignFocus(focus);
        }
        const panes = new Set(snapshot.agents.map(a => a.pane_id));
        if (panes.size !== this.subscribed.size || [...panes].some(pane => !this.subscribed.has(pane))) {
          await this.request("events.subscribe", { subscriptions: [
            ...NATIVE_EVENTS.map(type => ({ type })),
            ...[...panes].map(pane_id => ({ type: "pane.agent_status_changed", pane_id })),
          ] });
          if (this.socket !== socket) return;
          this.subscribed = panes;
        }
      } while (this.snapshotAgain && this.socket === socket);
    })();
    this.snapshotRequest = promise;
    return promise.finally(() => { if (this.snapshotRequest === promise) this.snapshotRequest = null; });
  }
  async focus(pane: string): Promise<void> {
    this.lastFocus = pane;
    await this.request("agent.focus", { target: pane });
    await this.refresh();
  }
  private alignFocus(pane: string): void {
    this.pendingFocus = pane;
    if (this.aligning) return;
    this.aligning = true;
    void (async () => {
      try {
        while (this.pendingFocus && this.ready) {
          const target = this.pendingFocus;
          this.pendingFocus = null;
          await this.request("pane.focus", { pane_id: target });
        }
      } catch {
        // The next snapshot or user action will retry; never loop here.
      } finally {
        this.aligning = false;
      }
    })();
  }
  async zoom(pane: string): Promise<void> {
    await this.request("pane.zoom", { pane_id: pane, mode: "toggle" });
  }
}
