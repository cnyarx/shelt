import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { NativeSnapshot } from "../../src/mobile-model.ts";

export async function mobileNative(directory: string) {
  const apiClients = new Set<Socket>(), subscribers = new Set<Socket>(), terminals = new Set<Socket>();
  const calls: { method: string; params: any }[] = [], input: string[] = [];
  let terminalStarts = 0;
  let snapshot: NativeSnapshot = {
    focused_pane_id: "w1:p1",
    workspaces: [{ workspace_id: "w1", label: "手机原生验收" }],
    tabs: [{ workspace_id: "w1", tab_id: "w1:t9", label: "完整标签九" }, { workspace_id: "w1", tab_id: "w1:t1", label: "完整标签一" }],
    agents: [
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", name: "第二个agent", agent: "qwen", agent_status: "blocked", cwd: directory },
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t9", name: "第一个agent", agent: "qwen", agent_status: "idle", cwd: directory },
    ],
  };
  const broadcast = (value: string) => { for (const socket of terminals) socket.write(value); };
  const event = (name: string) => { for (const socket of subscribers) socket.write(JSON.stringify({ event: name, data: { pane_id: snapshot.focused_pane_id } }) + "\n"); };
  const focus = (pane: string) => {
    snapshot = { ...snapshot, focused_pane_id: pane };
    broadcast(`\r\nFOCUS:${pane}\r\n`); event("pane.focused");
  };
  const api = createServer(socket => {
    apiClients.add(socket); socket.on("close", () => { apiClients.delete(socket); subscribers.delete(socket); });
    socket.on("error", () => {}); let buffer = "", handled = false;
    socket.on("data", chunk => {
      if (handled) throw new Error("Herdr API accepts one request per socket");
      buffer += chunk.toString(); let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        handled = true;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const request = JSON.parse(line); calls.push({ method: request.method, params: request.params });
        let result: any;
        switch (request.method) {
          case "ping": result = { type: "pong" }; break;
          case "session.snapshot": result = { type: "session_snapshot", snapshot }; break;
          case "events.subscribe": subscribers.add(socket); result = { type: "subscribed" }; break;
          case "agent.focus": {
            const agent = snapshot.agents.find(a => a.pane_id === request.params.target);
            if (!agent) { socket.end(JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "No such agent" } }) + "\n"); return; }
            focus(agent.pane_id); result = { type: "agent_info", agent }; break;
          }
          case "pane.focus": {
            const pane = request.params.pane_id;
            if (!snapshot.agents.some(a => a.pane_id === pane)) { socket.end(JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "No such pane" } }) + "\n"); return; }
            focus(pane); result = { type: "pane_info", pane_id: pane }; break;
          }
          case "pane.zoom": result = { type: "pane_zoom" }; event("layout.updated"); break;
          default: throw new Error(`Unexpected native method ${request.method}`);
        }
        const reply = JSON.stringify({ id: request.id, result }) + "\n";
        if (request.method === "events.subscribe") socket.write(reply);
        else socket.end(reply);
        return;
      }
    });
  });
  const terminal = createServer(socket => {
    terminalStarts++; terminals.add(socket); socket.on("error", () => {});
    socket.on("close", () => terminals.delete(socket));
    socket.write(`\x1b[2J\x1b[HNATIVE_UI:${snapshot.focused_pane_id}\r\n`);
    socket.on("data", bytes => { input.push(bytes.toString()); broadcast(bytes.toString()); });
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(join(directory, "native.sock"), resolve); }),
    new Promise<void>((resolve, reject) => { terminal.once("error", reject); terminal.listen(join(directory, "terminal.sock"), resolve); }),
  ]);
  return {
    calls, input, focus, snapshot: () => snapshot, terminalStarts: () => terminalStarts, terminalCount: () => terminals.size,
    replace(value: NativeSnapshot) { snapshot = value; event("tab.moved"); },
    async close() {
      for (const socket of [...apiClients, ...terminals]) socket.destroy();
      await Promise.all([new Promise<void>(r => api.close(() => r())), new Promise<void>(r => terminal.close(() => r()))]);
    },
  };
}
