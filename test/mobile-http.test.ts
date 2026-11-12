import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { editEnvironment } from "./fixtures/edit-environment.ts";
import { mobileNative } from "./fixtures/mobile-native.ts";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] as const : ["bun"] as const) {
  test(`${backend}: native control authentication, allowlist, remote scope and no session-file endpoints`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24910 : 24911, new URL("./fixtures/mobile-agent.ts", import.meta.url).pathname, directory => ({ HERDR_SOCKET_PATH: join(directory, "native.sock") }));
    const native = await mobileNative(env.directory);
    const sockets: WebSocket[] = [];
    try {
      await env.login(true);
      const connect = async (path: string, headers = { Cookie: env.cookie(), Origin: env.base }) => {
        const ws = new WebSocket(env.base.replace("http", "ws") + path, { headers } as never); sockets.push(ws);
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade rejected")); });
        return ws;
      };
      const call = (ws: WebSocket, method: string, params = {}, id = "test:1") => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 3000);
        const listener = (e: MessageEvent) => { const v = JSON.parse(String(e.data)); if (v.id === id) { clearTimeout(timer); ws.removeEventListener("message", listener); resolve(v); } };
        ws.addEventListener("message", listener); ws.send(JSON.stringify({ id, method, params }));
      });
      expect(await connect("/api/mobile/control?target=local", { Cookie: "", Origin: env.base }).then(() => false, () => true)).toBe(true);
      expect(await connect("/api/mobile/control?target=local", { Cookie: env.cookie(), Origin: "https://evil.example" }).then(() => false, () => true)).toBe(true);
      expect(await connect("/api/mobile/control?target=wrong").then(() => false, () => true)).toBe(true);
      expect(await connect("/ws?pane=w1:p1").then(() => false, () => true)).toBe(true);
      expect((await env.api("/api/mobile/chat?pane=w1:p1")).status).toBe(404);
      expect((await env.api("/api/mobile/agents")).status).toBe(404);
      const ws = await connect("/api/mobile/control?target=local");
      const response = await call(ws, "session.snapshot");
      expect(response.result.snapshot.focused_pane_id).toBe("w1:p1");
      expect(response.result.snapshot.agents).toHaveLength(2);
      expect((await call(ws, "agent.focus", { target: "w1:missing" })).error.code).toBe("agent_not_found");
      expect((await call(ws, "agent.focus", { target: "w1:p2" })).result.agent.pane_id).toBe("w1:p2");
      expect(native.snapshot().focused_pane_id).toBe("w1:p2");
      const rejected = new Promise<void>(resolve => ws.addEventListener("close", () => resolve()));
      ws.send(JSON.stringify({ id: "bad", method: "server.stop", params: {} })); await rejected;
      expect(native.calls.some(c => c.method === "server.stop")).toBe(false);
      const remote = await (await env.api("/api/herdr/targets", "POST", { name: "远端原生会话", remote: "editor@fixture.test", session: "named-session" })).json();
      const localAgain = await connect("/api/mobile/control?target=local");
      const localClosed = new Promise<void>(r => localAgain.addEventListener("close", () => r()));
      await env.api("/api/herdr/active", "POST", { id: remote.id }); await localClosed;
      expect(await connect("/api/mobile/control?target=local").then(() => false, () => true)).toBe(true);
      const remoteWs = await connect(`/api/mobile/control?target=${remote.id}`);
      expect((await call(remoteWs, "session.snapshot")).result.snapshot.agents).toHaveLength(2);
      expect((await call(remoteWs, "agent.focus", { target: "w1:p1" })).result.agent.pane_id).toBe("w1:p1");
      const calls = (await readFile(join(env.directory, "mobile-calls.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
      expect(calls.some(c => c.remote && c.args.length === 1 && c.args[0] === "remote-api-bridge")).toBe(true);
      expect(calls.some(c => c.args.includes("list") || c.args.includes("attach") || c.args.includes("process-info"))).toBe(false);
    } finally { for (const ws of sockets) ws.close(); await env.cleanup(); await native.close(); }
  }, 30000);

  test(`${backend}: two native UI connections share focus/output without terminal respawn or replacement`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24910 : 24911, new URL("./fixtures/mobile-agent.ts", import.meta.url).pathname, directory => ({ HERDR_SOCKET_PATH: join(directory, "native.sock") }));
    const native = await mobileNative(env.directory); const sockets: WebSocket[] = [];
    try {
      await env.login(true);
      const connect = async (path: string) => {
        const ws = new WebSocket(env.base.replace("http", "ws") + path, { headers: { Cookie: env.cookie(), Origin: env.base } } as never);
        ws.binaryType = "arraybuffer"; sockets.push(ws); let text = "";
        ws.onmessage = e => {
          const chunk = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
          text += chunk;
          if (path.startsWith("/ws") && typeof e.data !== "string") ws.send(JSON.stringify({ type: "output-ack", bytes: e.data.byteLength }));
        };
        await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("WS failed")); });
        return { ws, text: () => text };
      };
      const until = async (predicate: () => boolean) => { for (let i = 0; i < 120; i++) { if (predicate()) return; await Bun.sleep(20); } throw new Error("native output missing"); };
      const first = await connect("/ws?cols=50&rows=20"); await until(() => first.text().includes("NATIVE_UI"));
      const second = await connect("/ws?cols=100&rows=30"); await until(() => second.text().includes("NATIVE_UI"));
      expect(first.ws.readyState).toBe(WebSocket.OPEN); expect(native.terminalStarts()).toBe(2);
      const control = await connect("/api/mobile/control?target=local");
      control.ws.send(JSON.stringify({ id: "focus1", method: "agent.focus", params: { target: "w1:p2" } }));
      await until(() => first.text().includes("FOCUS:w1:p2") && second.text().includes("FOCUS:w1:p2"));
      expect(native.terminalStarts()).toBe(2);
      first.ws.send(JSON.stringify({ type: "input", data: "hello-native-once" }));
      await until(() => second.text().includes("hello-native-once") && first.text().includes("hello-native-once"));
      expect(native.input.join("")).toBe("hello-native-once");
      native.focus("w1:p1"); await until(() => first.text().includes("FOCUS:w1:p1") && second.text().includes("FOCUS:w1:p1"));
      first.ws.close(); await until(() => native.terminalCount() === 1);
      expect(second.ws.readyState).toBe(WebSocket.OPEN);
      second.ws.send(JSON.stringify({ type: "input", data: "surviving-client" })); await until(() => second.text().includes("surviving-client"));
      expect(native.terminalStarts()).toBe(2);
    } finally { for (const ws of sockets) ws.close(); await env.cleanup(); await native.close(); }
  }, 30000);
}
