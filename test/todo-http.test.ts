import { expect, test } from "bun:test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { editEnvironment } from "./fixtures/edit-environment.ts";
import { TodoStore } from "../src/todo-store.ts";
import { TODO_STATES } from "../src/todos.ts";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] as const : ["bun"] as const) {
  test(`${backend}: todo CRUD, nested moves, status transitions, conflicts, confirmation and persistence`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24861 : 24862);
    try {
      expect((await fetch(env.base + "/api/todos")).status).toBe(401);
      await env.login(true);
      let revision = 0, serial = 1;
      const call = async (path = "", method = "GET", body?: any, status = 200) => {
        const response = await env.api("/api/todos" + path, method, body);
        const value = await response.json();
        expect(response.status).toBe(status);
        if (response.ok && value.revision !== undefined) revision = value.revision;
        return value;
      };
      const create = (path: string, fields: any) => call(path, "POST", { revision, requestId: (serial++).toString(16).padStart(32, "0"), ...fields });
      expect(await call()).toEqual({ revision: 0, projects: [], items: [] });
      const p = (await create("/projects", { title: "项目 A <&>", description: "说明" })).result;
      const q = (await create("/projects", { title: "项目 B" })).result;
      expect((await call("/projects")).projects).toHaveLength(2);
      expect((await call(`/projects/${p.id}`)).project.title).toBe("项目 A <&>");
      const folder = (await create(`/projects/${p.id}/items`, { title: "一级", kind: "folder" })).result;
      const nested = (await create(`/projects/${p.id}/items`, { title: "二级", kind: "folder", parentId: folder.id })).result;
      const task = (await create(`/projects/${p.id}/items`, { title: "任务", kind: "task", parentId: nested.id })).result;
      for (const status of [...TODO_STATES, "todo", "done", "doing"]) expect((await call(`/items/${task.id}`, "PATCH", { revision, status })).result.status).toBe(status);
      const beforeInvalid = revision;
      for (const [path, fields] of [[`/items/${folder.id}`, { parentId: nested.id }], [`/items/${folder.id}`, { parentId: task.id }], [`/items/${folder.id}`, { status: "done" }], [`/items/${task.id}`, { parentId: "0".repeat(32) }], [`/items/${task.id}`, { kind: "folder" }]] as const) await call(path, "PATCH", { revision, ...fields }, 400);
      expect((await call()).revision).toBe(beforeInvalid);
      const moved = await call(`/items/${folder.id}`, "PATCH", { revision, projectId: q.id, order: -10 });
      expect(moved.snapshot.items.every((i: any) => i.projectId === q.id)).toBe(true);
      expect((await call(`/projects/${p.id}/items`)).items).toHaveLength(0);
      expect((await call(`/items/${task.id}`)).item.status).toBe("doing");
      await call(`/projects/${q.id}`, "DELETE", { revision }, 409);
      await call(`/items/${folder.id}`, "DELETE", { revision }, 409);
      await call(`/items/${task.id}`, "PATCH", { revision: revision - 1, status: "done" }, 409);
      const current = revision;
      const results = await Promise.all([env.api(`/api/todos/items/${task.id}`, "PATCH", { revision: current, title: "one" }), env.api(`/api/todos/items/${task.id}`, "PATCH", { revision: current, title: "two" })]);
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      await call();
      const body = { revision, requestId: "f".repeat(32), title: "幂等项目" };
      const once = await call("/projects", "POST", body);
      expect((await call("/projects", "POST", body)).result.id).toBe(once.result.id);
      await call("/projects", "POST", { ...body, title: "different" }, 409);
      expect((await stat(join(env.state, "todos.json"))).mode & 0o777).toBe(0o600);
      const saved = await call();
      await env.stop(); await env.start(); await env.login();
      expect(await call()).toEqual(saved);
      expect((await call("/projects", "POST", body)).result.id).toBe(once.result.id);
      await call();
      await call(`/items/${folder.id}`, "DELETE", { revision, recursive: true });
      expect((await call()).items).toHaveLength(0);
      await call(`/projects/${p.id}`, "PATCH", { revision, title: "renamed" });
      await call(`/projects/${p.id}`, "DELETE", { revision });
      expect((await call("/projects")).projects.some((x: any) => x.id === p.id)).toBe(false);
    } finally { await env.cleanup(); }
  }, 45000);

  test(`${backend}: todo Bearer authorization, revocation, expiry, scoped events and prompt privacy`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24863 : 24864);
    try {
      await env.login(true);
      let view = await (await env.api("/api/todos")).json();
      const create = async (title: string) => {
        const r = await env.api("/api/todos/projects", "POST", { revision: view.revision, requestId: crypto.randomUUID().replaceAll("-", ""), title });
        expect(r.status).toBe(200); const value = await r.json(); view = value.snapshot; return value.result;
      };
      const p = await create("Allowed"), q = await create("Private");
      const tokenResult = await env.api("/api/todos/grants", "POST", { projectId: p.id, ttlSeconds: 3600 });
      expect(tokenResult.status).toBe(200); const grant = await tokenResult.json();
      const bearer = (path = "", method = "GET", body?: unknown, extras = {}) => fetch(env.base + "/api/todos" + path, { method, headers: { Authorization: `Bearer ${grant.token}`, "Content-Type": "application/json", ...extras }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const snapshot = await (await bearer()).json(); expect(snapshot.projects.map((x: any) => x.id)).toEqual([p.id]);
      expect(snapshot.tokens).toBeUndefined();
      expect((await bearer(`/projects/${q.id}`)).status).toBe(403);
      expect((await bearer("/projects", "POST", { revision: snapshot.revision, requestId: "1".repeat(32), title: "Unauthorized project" })).status).toBe(403);
      for (const route of ["/grants", "/prompt", "/agents", "/send"]) expect((await bearer(route)).status).toBe(403);
      expect((await fetch(env.base + "/api/herdr/targets", { headers: { Authorization: `Bearer ${grant.token}` } })).status).toBe(401);
      expect((await bearer(`/projects/${p.id}`, "PATCH", { revision: snapshot.revision, title: "unsafe" }, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await env.api("/api/todos/projects", "POST", {}, { Origin: "https://evil.example" })).status).toBe(403);
      const eventAbort = new AbortController();
      const events = await fetch(env.base + "/api/todos/events", { signal: eventAbort.signal, headers: { Authorization: `Bearer ${grant.token}` } });
      const reader = events.body!.getReader();
      const initial = new TextDecoder().decode((await reader.read()).value); expect(initial).toContain("Allowed"); expect(initial).not.toContain("Private");
      view = await (await env.api("/api/todos")).json();
      const change = await env.api(`/api/todos/projects/${p.id}`, "PATCH", { revision: view.revision, title: "Updated" }); expect(change.status).toBe(200);
      const update = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("todo event timeout"); })]);
      expect(new TextDecoder().decode(update.value)).toContain("Updated");
      await env.api(`/api/todos/grants/${grant.id}`, "DELETE", {});
      expect((await bearer()).status).toBe(401);
      const ended = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("revoked SSE did not close"); })]); expect(ended.done).toBe(true); eventAbort.abort();
      const expired = await (await env.api("/api/todos/grants", "POST", { projectId: null, ttlSeconds: 3600 })).json();
      const dataPath = join(env.state, "todos.json"), data = JSON.parse(await readFile(dataPath, "utf8")); data.tokens.find((g: any) => g.id === expired.id).expiresAt = Date.now() - 1;
      await writeFile(dataPath, JSON.stringify(data));
      expect((await fetch(env.base + "/api/todos", { headers: { Authorization: `Bearer ${expired.token}` } })).status).toBe(401);
      const invalid = await env.api("/api/todos/prompt", "POST", { projectId: p.id, ttlSeconds: 3600, baseUrl: "https://evil.example" }); expect(invalid.status).toBe(400);
      const promptResponse = await env.api("/api/todos/prompt", "POST", { projectId: p.id, ttlSeconds: 3600, baseUrl: env.base }); expect(promptResponse.status).toBe(200);
      const generated = await promptResponse.json();
      expect(generated.prompt).toContain(env.base + "/api/todos"); expect(generated.prompt).toContain("无证据保留原状态"); expect(generated.prompt).not.toContain("Private");
      const promptToken = generated.prompt.match(/SHELT_TODO_TOKEN="([a-f0-9]{64})"/)?.[1]; expect(promptToken).toHaveLength(64);
      expect((await readFile(dataPath, "utf8")).includes(promptToken)).toBe(false);
      const publicGrants = await (await env.api("/api/todos/grants")).text(); expect(publicGrants).not.toContain(promptToken); expect(publicGrants).not.toContain('"hash"');
      expect(await env.received()).toHaveLength(0);
    } finally { await env.cleanup(); }
  }, 45000);
}

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] as const : ["bun"] as const) {
  test(`${backend}: explicitly delivered todo prompt drives real scoped and all-project CRUD without leaking credentials`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24868 : 24869, new URL("./fixtures/todo-agent.ts", import.meta.url).pathname);
    const received = async () => (await readFile(join(env.directory, "todo-received.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    try {
      await env.login(true);
      const agentList = await (await env.api("/api/todos/agents")).json();
      expect(agentList.source.title).toBe("local editor");
      const project = await (await env.api("/api/todos/projects", "POST", { revision: 0, requestId: "9".repeat(32), title: "Agent project" })).json();
      const generated = await (await env.api("/api/todos/prompt", "POST", { projectId: project.result.id, ttlSeconds: 3600, baseUrl: env.base })).json();
      expect(await received()).toHaveLength(0);
      const body = { requestId: "a".repeat(32), grantId: generated.grantId, targetId: agentList.source.targetId, paneId: agentList.source.paneId, session: agentList.source.session };
      await env.setControl({ status: "working", executeTodos: true });
      const busy = await env.api("/api/todos/send", "POST", body); expect(busy.status).toBe(409); expect((await busy.json()).error).toBe("agent_busy");
      expect(await received()).toHaveLength(0);
      await env.setControl({ executeTodos: true });
      const delivery = await env.api("/api/todos/send", "POST", body); expect(delivery.status).toBe(200); expect((await delivery.json()).state).toBe("sent");
      expect((await received())[0].methods.some((c: any) => c.method === "DELETE")).toBe(true);
      expect((await received())[0].receiptWasPending).toBe(true);
      let view = await (await env.api("/api/todos")).json();
      expect(view.items.find((i: any) => i.title === "Agent 实际同步任务").status).toBe("done");
      expect((await (await env.api("/api/todos/send", "POST", body)).json()).state).toBe("sent");
      expect(await received()).toHaveLength(1);
      const token = generated.prompt.match(/SHELT_TODO_TOKEN="([a-f0-9]{64})"/)[1];
      expect(await readFile(join(env.directory, "todo-received.jsonl"), "utf8")).not.toContain(token);
      expect(await readFile(join(env.state, "todo-delivery-receipts", body.requestId + ".json"), "utf8")).not.toContain(token);
      expect(await readFile(join(env.state, "todos.json"), "utf8")).not.toContain(token);
      const all = await (await env.api("/api/todos/prompt", "POST", { projectId: null, ttlSeconds: 3600, baseUrl: env.base })).json();
      await env.setControl({ executeTodos: true, allScope: true });
      const result = await env.api("/api/todos/send", "POST", { ...body, requestId: "b".repeat(32), grantId: all.grantId });
      expect(result.status).toBe(200); expect((await result.json()).state).toBe("sent");
      const methods = (await received())[1].methods;
      expect(methods.some((c: any) => c.path === "/projects" && c.method === "POST")).toBe(true);
      expect(methods.some((c: any) => c.path.startsWith("/projects/") && c.method === "DELETE")).toBe(true);
      view = await (await env.api("/api/todos")).json(); expect(view.projects).toHaveLength(1);
      await env.api(`/api/todos/grants/${all.grantId}`, "DELETE", {});
      expect((await env.api("/api/todos/send", "POST", { ...body, requestId: "c".repeat(32), grantId: all.grantId })).status).toBe(410);
      expect(await received()).toHaveLength(2);
    } finally { await env.cleanup(); }
  }, 45000);
}

test.skipIf(!process.env.SHELT_TEST_RUST)("todo disk format and create idempotency work across Bun/Rust restarts", async () => {
  const env = await editEnvironment("bun", 24865);
  try {
    await env.login(true); const body = { revision: 0, requestId: "2".repeat(32), title: "跨后端项目" };
    const first = await (await env.api("/api/todos/projects", "POST", body)).json();
    const disk = await new TodoStore(join(env.state, "todos.json")).read();
    expect(disk.projects[0]?.id).toBe(first.result.id);
    await env.stop();
    const child = Bun.spawn(["target/debug/shelt", "foreground"], { env: { ...process.env, HOME: env.directory, SHELT_HOST: "127.0.0.1", SHELT_PORT: "24865", SHELT_STATE_DIR: env.state, SHELT_UPLOAD_DIR: join(env.directory, "uploads"), SHELT_PUBLIC_HOSTS: "127.0.0.1:24865", SHELT_MODE: "shell" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 100; i++) { try { if ((await fetch(env.base + "/health")).ok) break; } catch {} await Bun.sleep(50); }
      await env.login();
      const replay = await env.api("/api/todos/projects", "POST", body); expect(replay.status).toBe(200); expect((await replay.json()).result.id).toBe(first.result.id);
      const current = await (await env.api("/api/todos")).json(); expect(current.projects).toHaveLength(1);
    } finally { child.kill(); await child.exited; }
  } finally { await env.cleanup(); }
}, 30000);
