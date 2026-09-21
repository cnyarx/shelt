import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] : ["bun"]) {
  test(`${backend}: target CRUD, activation, persistence and password change`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-targets-http-"));
    const port = backend === "rust" ? 34802 : 34801;
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory, SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "shell" };
    const start = () => Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
    let child = start();
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
        await Bun.sleep(50);
      }
      throw new Error("Server did not start");
    };
    const stop = async () => { child.kill(); await child.exited; };
    try {
      await ready();
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "targets-test-password" }) });
      expect(setup.status).toBe(200);
      let cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const login = async (password = "targets-test-password") => {
        const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
        return response;
      };
      const api = (path: string, method = "GET", body?: unknown, origin = base) => fetch(`${base}${path}`, {
        method,
        headers: { cookie, ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect((await api("/api/herdr/targets", "GET", undefined, "")).status).toBe(200);
      expect((await fetch(`${base}/api/herdr/targets`)).status).toBe(401);
      expect((await fetch(`${base}/api/auth/password`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "x-password", newPassword: "y-password" }) })).status).toBe(401);
      expect((await api("/api/herdr/targets", "POST", { name: "x", remote: "example.com" }, "https://evil.example")).status).toBe(403);
      expect((await api("/api/herdr/active", "POST", { id: "local" }, "https://evil.example")).status).toBe(403);

      const initial = await (await api("/api/herdr/targets")).json();
      expect(initial).toEqual({ mode: "shell", active: "local", targets: [] });

      for (const remote of ["-oProxyCommand=evil", "host; rm -rf /", "host$(whoami)", "host`id`", "host name"]) {
        expect((await api("/api/herdr/targets", "POST", { name: "bad", remote })).status).toBe(400);
      }
      expect((await api("/api/herdr/targets", "POST", { name: "bad", remote: "example.com", session: "has space" })).status).toBe(400);

      const created = await (await api("/api/herdr/targets", "POST", { name: "开发机", remote: "dev@10.0.0.2", session: "work" })).json();
      expect(created.id).toMatch(/^[a-f0-9]{8}$/);
      expect(created.session).toBe("work");
      expect((await (await api("/api/herdr/targets")).json()).targets.length).toBe(1);

      const updated = await (await api(`/api/herdr/targets/${created.id}`, "PUT", { name: "开发机2", remote: "dev@10.0.0.3" })).json();
      expect(updated.name).toBe("开发机2");
      expect(updated.session).toBeNull();
      expect((await api("/api/herdr/targets/ffffffff", "PUT", { name: "x", remote: "example.com" })).status).toBe(404);

      expect((await api("/api/herdr/active", "POST", { id: "ffffffff" })).status).toBe(404);
      expect((await api("/api/herdr/active", "POST", { id: created.id })).status).toBe(200);
      expect((await (await api("/api/herdr/targets")).json()).active).toBe(created.id);
      expect(await readFile(join(directory, "herdr-targets.json"), "utf8")).toContain("dev@10.0.0.3");

      await stop(); child = start(); await ready();
      const relogin = await login();
      expect(relogin.status).toBe(200);
      cookie = relogin.headers.get("set-cookie")!.split(";")[0]!;
      const reloaded = await (await api("/api/herdr/targets")).json();
      expect(reloaded.active).toBe(created.id);
      expect(reloaded.targets[0].remote).toBe("dev@10.0.0.3");

      expect((await api(`/api/herdr/targets/${created.id}`, "DELETE")).status).toBe(200);
      expect((await (await api("/api/herdr/targets")).json()).active).toBe("local");
      expect((await api(`/api/herdr/targets/${created.id}`, "DELETE")).status).toBe(404);

      const other = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "targets-test-password" }) });
      const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
      const change = (body: unknown, session = cookie) => fetch(`${base}/api/auth/password`, { method: "POST", headers: { cookie: session, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect((await change({ currentPassword: "wrong-password", newPassword: "replacement-password" })).status).toBe(401);
      expect((await change({ currentPassword: "targets-test-password", newPassword: "short" })).status).toBe(400);
      expect((await change({ currentPassword: "targets-test-password", newPassword: "replacement-password" })).status).toBe(200);
      expect((await fetch(`${base}/api/herdr/targets`, { headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${base}/api/herdr/targets`, { headers: { cookie: otherCookie } })).status).toBe(401);
      expect((await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "targets-test-password" }) })).status).toBe(401);
      expect((await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "replacement-password" }) })).status).toBe(200);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  test(`${backend}: switching target respawns herdr with remote arguments`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-targets-switch-"));
    const fakeHerdr = join(directory, "fake-herdr");
    const argvFile = join(directory, "argv.txt");
    await writeFile(fakeHerdr, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SHELT_FAKE_ARGV"\nsleep 30\n');
    await chmod(fakeHerdr, 0o755);
    const port = backend === "rust" ? 34804 : 34803;
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory, SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "herdr", SHELT_HERDR_BIN: fakeHerdr, SHELT_FAKE_ARGV: argvFile };
    const child = Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
    const sockets: WebSocket[] = [];
    const waitArgv = async (needle: string | null) => {
      for (let i = 0; i < 100; i++) {
        const content = await readFile(argvFile, "utf8").catch(() => null);
        if (content !== null && (needle === null ? true : content.includes(needle))) return content;
        await Bun.sleep(50);
      }
      throw new Error(`fake herdr argv did not contain ${needle}`);
    };
    const connect = () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?cols=80&rows=24`, { headers: { Origin: base, cookie } } as never);
      sockets.push(ws);
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });
    let cookie = "";
    try {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
        await Bun.sleep(50);
      }
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "switch-test-password" }) });
      cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const api = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });

      let ws = await connect();
      expect((await waitArgv(null)).trim()).toBe("");

      const created = await (await api("/api/herdr/targets", { name: "开发机", remote: "dev@10.0.0.2", session: "work" })).json();
      const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
      expect((await api("/api/herdr/active", { id: created.id })).status).toBe(200);
      await closed;
      ws = await connect();
      const remote = await waitArgv("--remote");
      expect(remote.trim().split("\n")).toEqual(["--remote", "dev@10.0.0.2", "--session", "work"]);

      const closedAgain = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
      expect((await api("/api/herdr/active", { id: "local" })).status).toBe(200);
      await closedAgain;
      await rm(argvFile, { force: true });
      await connect();
      expect((await waitArgv(null)).trim()).toBe("");
    } finally {
      for (const ws of sockets) ws.close();
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
}
