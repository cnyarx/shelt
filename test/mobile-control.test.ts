import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(["mobile-model", "mobile-control"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", "")).join("\n"));
const tick = () => new Promise(r => setTimeout(r, 0));
function setup() {
  const sockets: FakeSocket[] = [], updates: any[] = [];
  const requests: any[] = [];
  let pane = "p1", unavailable = 0, holdSnapshot = false, pending: { socket: FakeSocket; id: string }[] = [];
  const snapshot = () => ({ focused_pane_id: pane, workspaces: [], tabs: [], agents: [{ pane_id: "p1" }, { pane_id: "p2" }] });
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; handlers = new Map<string, Function[]>(); closed = false;
    constructor(public url: string) { sockets.push(this); }
    addEventListener(name: string, fn: Function) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]); }
    emit(name: string, value: any = {}) { for (const fn of this.handlers.get(name) ?? []) fn(value); }
    reply(id: string, result: object) { this.emit("message", { data: JSON.stringify({ id, result }) }); }
    send(text: string) {
      const r = JSON.parse(text); requests.push(r);
      queueMicrotask(() => {
        if (r.method === "session.snapshot") {
          if (holdSnapshot) pending.push({ socket: this, id: r.id }); else this.reply(r.id, { snapshot: snapshot() });
        } else if (r.method === "agent.focus") {
          pane = r.params.target; this.emit("message", { data: JSON.stringify({ event: "pane.focused", data: { pane_id: pane } }) }); this.reply(r.id, { agent: { pane_id: pane } });
        } else if (r.method === "pane.focus") {
          pane = r.params.pane_id; this.reply(r.id, {});
        } else this.reply(r.id, {});
      });
    }
    close() { this.closed = true; this.readyState = 3; this.emit("close"); }
  }
  const ctx: any = { WebSocket: FakeSocket, location: { protocol: "http:", host: "fixture.test" }, setTimeout, clearTimeout, receive: (v: any) => updates.push(v), fail: () => { unavailable++; } };
  runInNewContext(source + '\nglobalThis.control = new MobileControl(globalThis.receive, globalThis.fail);', ctx);
  return { control: ctx.control, sockets, updates, requests, unavailable: () => unavailable,
    hold() { holdSnapshot = true; },
    setPane(value: string) { pane = value; },
    release() { holdSnapshot = false; const old = pending; pending = []; for (const p of old) p.socket.reply(p.id, { snapshot: snapshot() }); },
    event(name = "pane.focused") { sockets.at(-1)!.emit("message", { data: JSON.stringify({ event: name, data: { pane_id: pane } }) }); },
  };
}

test("native control bootstraps once, remains idle without polling, focuses on the same socket", async () => {
  const env = setup(); env.control.connect("local"); env.sockets[0]!.emit("open"); await tick();
  expect(env.control.ready).toBe(true); expect(env.updates.at(-1).focused_pane_id).toBe("p1");
  expect(env.requests.filter(r => r.method === "session.snapshot")).toHaveLength(1);
  const idle = env.requests.length; await Bun.sleep(30); expect(env.requests).toHaveLength(idle);
  await env.control.focus("p2"); expect(env.updates.at(-1).focused_pane_id).toBe("p2");
  expect(env.sockets).toHaveLength(1); expect(env.sockets[0]!.closed).toBe(false);
  expect(env.requests.filter(r => r.method === "agent.focus")).toHaveLength(1);
  expect(env.requests.filter(r => r.method === "pane.focus")).toHaveLength(0);
  await env.control.zoom("p2"); expect(env.requests.at(-1)).toMatchObject({ method: "pane.zoom", params: { pane_id: "p2", mode: "toggle" } });
  env.control.close(); expect(env.sockets[0]!.closed).toBe(true);
});

test("external focus changes are re-broadcast through Herdr's public focus API without looping", async () => {
  const env = setup(); env.control.connect("local"); env.sockets[0]!.emit("open"); await tick();
  env.setPane("p2");
  env.sockets[0]!.emit("message", { data: JSON.stringify({ event: "pane.focused", data: { pane_id: "p2" } }) });
  await tick(); await tick();
  const aligns = env.requests.filter(r => r.method === "pane.focus");
  expect(aligns).toHaveLength(1);
  expect(aligns[0].params).toEqual({ pane_id: "p2" });
  await tick(); await tick();
  expect(env.requests.filter(r => r.method === "pane.focus")).toHaveLength(1);
  env.control.close();
});

test("native event bursts coalesce snapshots and stale connection responses cannot update a new target", async () => {
  const env = setup(); env.control.connect("local"); env.sockets[0]!.emit("open"); await tick();
  env.hold(); const before = env.requests.length;
  for (let i = 0; i < 20; i++) env.event("tab.renamed"); await tick();
  expect(env.requests.length - before).toBe(1);
  env.release(); await tick(); expect(env.requests.length - before).toBe(2);
  env.hold(); const old = env.control.refresh(); await tick();
  const oldResult = old.then(() => "resolved", (error: Error) => error.message);
  env.control.connect("remote-id"); env.release();
  expect(await oldResult).toBe("Herdr disconnected");
  const count = env.updates.length; env.sockets[0]!.emit("message", { data: JSON.stringify({ id: "old", result: { snapshot: { focused_pane_id: "wrong" } } }) });
  expect(env.updates.length).toBe(count);
  env.sockets[1]!.emit("open"); await tick(); expect(env.control.ready).toBe(true);
  env.control.close();
});
