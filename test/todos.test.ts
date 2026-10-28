import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TodoStore } from "../src/todo-store.ts";
import { TODO_STATES, checkTodoTree, descendants, emptyTodos, todoMutation, todoPrompt, todoSummary, type TodoData } from "../src/todos.ts";

const root = { scope: null, grantId: null };
const hex = (n: number) => n.toString(16).padStart(32, "0");
const change = (data: TodoData, method: string, path: string[], body: Record<string, unknown>, n = 1) => {
  const value = todoMutation(data, root, method, path, body, hex(n)) as any;
  data.revision++; return value;
};

test("leaf states can complete, reopen, block and cancel; ancestors aggregate active leaves only", () => {
  const data = emptyTodos();
  const p = change(data, "POST", ["projects"], { title: "项目 <&>" });
  const folder = change(data, "POST", ["projects", p.id, "items"], { title: "清单", kind: "folder" }, 2);
  const nested = change(data, "POST", ["projects", p.id, "items"], { title: "子清单", kind: "folder", parentId: folder.id }, 3);
  const task = change(data, "POST", ["projects", p.id, "items"], { title: "任务", kind: "task", parentId: nested.id }, 4);
  for (const status of [...TODO_STATES, "todo", "done", "doing"] as const) {
    change(data, "PATCH", ["items", task.id], { status });
    const summary = todoSummary(data.items, folder.id);
    expect(summary.total).toBe(1);
    expect(summary[status]).toBe(1);
    expect(summary.active).toBe(status === "canceled" ? 0 : 1);
    expect(summary.remaining).toBe(["done", "canceled"].includes(status) ? 0 : 1);
  }
  expect(descendants(data.items, folder.id)).toEqual([nested.id, task.id]);
  expect(() => change(data, "PATCH", ["items", folder.id], { status: "done" })).toThrow();
});

test("tree movement preserves descendants and prevents cycles, task parents and orphan references", () => {
  const data = emptyTodos();
  const p = change(data, "POST", ["projects"], { title: "A" }), q = change(data, "POST", ["projects"], { title: "B" }, 2);
  const folder = change(data, "POST", ["projects", p.id, "items"], { title: "Folder", kind: "folder" }, 3);
  const task = change(data, "POST", ["projects", p.id, "items"], { title: "Task", kind: "task", parentId: folder.id, status: "blocked" }, 4);
  for (const body of [{ parentId: task.id }, { parentId: folder.id }, { parentId: hex(99) }]) {
    const copy = structuredClone(data);
    expect(() => change(copy, "PATCH", ["items", folder.id], body)).toThrow();
  }
  change(data, "PATCH", ["items", folder.id], { projectId: q.id, order: -5 });
  expect(data.items.every(i => i.projectId === q.id)).toBe(true);
  expect(data.items.find(i => i.id === task.id)?.status).toBe("blocked");
  expect(data.items.find(i => i.id === folder.id)?.order).toBe(-5);
  expect(() => change(structuredClone(data), "DELETE", ["projects", q.id], {})).toThrow("confirmation_required");
  expect(() => change(structuredClone(data), "DELETE", ["items", folder.id], {})).toThrow("confirmation_required");
  change(data, "DELETE", ["items", folder.id], { recursive: true });
  expect(data.items).toHaveLength(0); checkTodoTree(data);
});

test("persistent store replays creates before checking revisions and limits credentials by scope/expiry/revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shelt-todo-store-"));
  try {
    const store = new TodoStore(join(dir, "todos.json"));
    const create = { revision: 0, requestId: hex(1), title: "A" };
    const created = await store.mutate("POST", ["projects"], create, null, true) as any;
    await store.mutate("PATCH", ["projects", created.result.id], { revision: 1, title: "renamed" }, null, true);
    expect((await store.mutate("POST", ["projects"], create, null, true) as any).result.id).toBe(created.result.id);
    await expect(store.mutate("POST", ["projects"], { ...create, title: "different" }, null, true)).rejects.toThrow("request_conflict");
    const grant = await store.grant(created.result.id, 3600, true);
    const data = await store.read();
    expect(store.actor(data, grant.token, false).scope).toBe(created.result.id);
    expect(() => store.actor(data, grant.token, false, grant.expiresAt)).toThrow("invalid_token");
    expect((await readFile(store.file, "utf8")).includes(grant.token)).toBe(false);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect((await new TodoStore(store.file).read()).projects[0]?.title).toBe("renamed");
    await store.revoke(grant.id, true);
    expect(() => store.actor({ ...data, tokens: data.tokens.map(g => ({ ...g, revoked: true })) }, grant.token, false)).toThrow("invalid_token");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prompt includes real API location, CRUD methods, current versions and evidence-based update rules", () => {
  const prompt = todoPrompt("https://shelt.example", "<temporary-token>", null, 1793088000000, { revision: 7, projects: [], items: [] });
  for (const text of ["https://shelt.example/api/todos", "Authorization: Bearer", "POST /api/todos/projects", "PATCH /api/todos/items", "DELETE /api/todos/items", '"revision": 7', "无证据保留原状态", "409", "recursive", "全清单"]) expect(prompt).toContain(text);
});
