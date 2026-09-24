import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

type FakeAgent = { pane_id: string; agent_status: string; agent: string | null; terminal_title_stripped: string; cwd: string };

async function fakeHerdrServer(socketPath: string) {
  const sockets = new Set<Socket>();
  const received: { id: string; method: string; params: any }[] = [];
  const agents: FakeAgent[] = [
    { pane_id: "w2:p7", agent_status: "working", agent: "qwen", terminal_title_stripped: "Qwen - irds", cwd: "/home/admin/irds" },
    { pane_id: "w2:p8", agent_status: "idle", agent: null, terminal_title_stripped: "", cwd: "" },
  ];
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message: { id: string; method: string; params: any };
        try { message = JSON.parse(line); } catch { continue; }
        received.push(message);
        if (message.method === "ping") socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        else if (message.method === "agent.list") socket.write(`${JSON.stringify({ id: message.id, result: { agents } })}\n`);
        else if (message.method === "events.subscribe") socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    received,
    pushEvent: (event: string, data: unknown) => {
      const frame = `${JSON.stringify({ event, data })}\n`;
      for (const socket of sockets) socket.write(frame);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sseConsumer(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];
  const takeFrame = (predicate: (data: string) => boolean): string | null => {
    const index = pending.findIndex(predicate);
    if (index < 0) return null;
    return pending.splice(index, 1)[0]!;
  };
  const read = async (predicate: (data: string) => boolean, timeoutMs = 8000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    const found = takeFrame(predicate);
    if (found) return JSON.parse(found);
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE frame timeout")), deadline - Date.now())),
      ]);
      if (done) throw new Error("SSE stream closed early");
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) pending.push(line.slice(6));
        }
      }
      const matched = takeFrame(predicate);
      if (matched) return JSON.parse(matched);
    }
    throw new Error("SSE frame not found before timeout");
  };
  return { read, close: () => reader.cancel().catch(() => {}) };
}

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] : ["bun"]) {
  test(`${backend}: herdr agent event stream bridges status changes over SSE`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-herdr-events-"));
    const socketPath = join(directory, "herdr.sock");
    const fakeHerdr = join(directory, "fake-herdr");
    await writeFile(fakeHerdr, "#!/bin/sh\nsleep 30\n");
    await chmod(fakeHerdr, 0o755);
    const fake = await fakeHerdrServer(socketPath);
    const port = backend === "rust" ? 34802 : 34801;
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory,
      SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory,
      SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "herdr", SHELT_HERDR_BIN: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
    };
    const child = Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
    const stop = async () => { child.kill(); await child.exited; };
    try {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
        await Bun.sleep(50);
      }
      expect((await fetch(`${base}/api/herdr/agent-events`)).status).toBe(401);
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "herdr-events-password" }) });
      expect(setup.status).toBe(200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie };

      const response = await fetch(`${base}/api/herdr/agent-events`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const stream = sseConsumer(response.body!);
      // The first frame can be an empty snapshot emitted before the bridge
      // finishes its handshake; the bridge then broadcasts the real snapshot.
      const snapshot = await stream.read((data) => data.includes("\"snapshot\"") && !data.includes("\"agents\":[]"));
      expect(snapshot.agents).toEqual([
        { paneId: "w2:p7", status: "working", title: "Qwen - irds", agent: "qwen", cwd: "/home/admin/irds" },
        { paneId: "w2:p8", status: "idle", title: "w2:p8", agent: "", cwd: "" },
      ]);

      let subscribed = false;
      for (let i = 0; i < 100 && !subscribed; i++) {
        subscribed = fake.received.some((message) => message.method === "events.subscribe"
          && message.params.subscriptions.some((entry: any) => entry.type === "pane.agent_status_changed" && entry.pane_id === "w2:p7")
          && message.params.subscriptions.some((entry: any) => entry.type === "pane.agent_detected")
          && message.params.subscriptions.some((entry: any) => entry.type === "pane.closed"));
        if (!subscribed) await Bun.sleep(50);
      }
      expect(subscribed).toBe(true);
      expect(fake.received.some((message) => message.method === "ping")).toBe(true);

      fake.pushEvent("pane.agent_status_changed", { pane_id: "w2:p7", agent_status: "done", agent: "qwen", workspace_id: "w2" });
      const done = await stream.read((data) => data.includes("\"status\""));
      expect(done).toEqual({ type: "status", paneId: "w2:p7", status: "done", title: "Qwen - irds", agent: "qwen" });

      fake.pushEvent("pane.agent_status_changed", { pane_id: "w2:p8", agent_status: "blocked", agent: null, workspace_id: "w2" });
      const blocked = await stream.read((data) => data.includes("blocked"));
      expect(blocked).toEqual({ type: "status", paneId: "w2:p8", status: "blocked", title: "w2:p8", agent: "" });

      fake.pushEvent("pane.closed", { pane_id: "w2:p7", workspace_id: "w2" });
      const removed = await stream.read((data) => data.includes("\"removed\""));
      expect(removed).toEqual({ type: "removed", paneId: "w2:p7" });
      stream.close();
    } finally {
      await stop();
      await fake.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  test(`${backend}: agent event stream is unavailable in shell mode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-herdr-shell-"));
    const port = backend === "rust" ? 34804 : 34803;
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory,
      SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory,
      SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "shell",
    };
    const child = Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
    const stop = async () => { child.kill(); await child.exited; };
    try {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
        await Bun.sleep(50);
      }
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "herdr-shell-password" }) });
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const response = await fetch(`${base}/api/herdr/agent-events`, { headers: { cookie } });
      expect(response.status).toBe(503);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
}
