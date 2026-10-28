import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkTodoTree, emptyTodos, todoFail, todoMutation, todoView, validId, type TodoActor, type TodoData } from "./todos.ts";

export const todoId = () => randomBytes(16).toString("hex");
export const todoHash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class TodoStore {
  constructor(readonly file: string) {}
  async read(): Promise<TodoData> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as TodoData;
      checkTodoTree(data);
      return data;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyTodos(); throw e; }
  }
  actor(data: TodoData, bearer: string | null, cookie: boolean, now = Date.now()): TodoActor {
    if (bearer !== null) {
      if (!/^[a-f0-9]{64}$/.test(bearer)) todoFail(401, "invalid_token");
      const grant = data.tokens.find(g => g.hash === todoHash(bearer) && !g.revoked && g.expiresAt > now);
      if (!grant || grant.projectId !== null && !data.projects.some(p => p.id === grant.projectId)) todoFail(401, "invalid_token");
      return { scope: grant.projectId, grantId: grant.id };
    }
    if (!cookie) todoFail(401, "authentication_required");
    return { scope: null, grantId: null };
  }
  async write<T>(action: (data: TodoData) => T): Promise<T> {
    const parent = dirname(this.file), lock = join(parent, "todos.lock");
    await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") todoFail(409, "write_busy"); throw e; }
    const temp = this.file + "." + todoId() + ".tmp";
    try {
      const data = await this.read(); const result = action(data); checkTodoTree(data);
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
      const directory = await open(parent, "r"); try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally { await unlink(temp).catch(() => {}); await rmdir(lock); }
  }
  async query(path: string[], bearer: string | null, cookie: boolean): Promise<unknown> {
    const data = await this.read(), actor = this.actor(data, bearer, cookie), view = todoView(data, actor.scope);
    if (!path.length) return view;
    if (path[0] === "projects" && path.length === 1) return { revision: view.revision, projects: view.projects };
    const node = path[0] === "projects" ? data.projects.find(p => p.id === path[1]) : path[0] === "items" ? data.items.find(i => i.id === path[1]) : undefined;
    if (!node) todoFail(404, "not_found");
    if (actor.scope !== null && ("projectId" in node ? node.projectId : node.id) !== actor.scope) todoFail(403, "scope_forbidden");
    if (path[0] === "projects" && path[2] === "items" && path.length === 3) return { revision: view.revision, items: view.items.filter(i => i.projectId === node.id) };
    if (path.length !== 2) todoFail(404, "not_found");
    return { revision: view.revision, [path[0] === "projects" ? "project" : "item"]: node };
  }
  async mutate(method: string, path: string[], body: Record<string, any>, bearer: string | null, cookie: boolean) {
    return this.write(data => {
      const actor = this.actor(data, bearer, cookie);
      const creating = method === "POST";
      const digest = todoHash(canonical({ method, path, body, actor: { scope: actor.scope, grantId: actor.grantId } }));
      if (creating) {
        if (!validId(body.requestId)) todoFail(400, "invalid_request_id");
        const saved = data.receipts[body.requestId];
        if (saved) { if (saved.digest !== digest) todoFail(409, "request_conflict"); return saved.result; }
      }
      if (body.revision !== data.revision) todoFail(409, "revision_conflict");
      const result = todoMutation(data, actor, method, path, body, todoId());
      data.revision++;
      const reply = { revision: data.revision, result, snapshot: todoView(data, actor.scope) };
      if (creating) data.receipts[body.requestId] = { digest, result: reply };
      return reply;
    });
  }
  async grant(projectId: string | null, ttlSeconds: number, cookie: boolean) {
    if (!cookie) todoFail(401, "authentication_required");
    if (![3600, 28800, 86400].includes(ttlSeconds)) todoFail(400, "invalid_expiry");
    const token = randomBytes(32).toString("hex");
    const grant = await this.write(data => {
      if (projectId !== null && !data.projects.some(p => p.id === projectId)) todoFail(404, "not_found");
      const value = { id: todoId(), hash: todoHash(token), projectId, expiresAt: Date.now() + ttlSeconds * 1000, revoked: false };
      data.tokens.push(value); data.revision++; return value;
    });
    const { hash: _, ...publicGrant } = grant;
    return { ...publicGrant, token };
  }
  async grants(cookie: boolean) {
    if (!cookie) todoFail(401, "authentication_required");
    return { grants: (await this.read()).tokens.map(({ hash: _, ...g }) => g) };
  }
  async revoke(id: string, cookie: boolean) {
    if (!cookie) todoFail(401, "authentication_required");
    return this.write(data => {
      const grant = data.tokens.find(g => g.id === id); if (!grant) todoFail(404, "not_found");
      grant.revoked = true; data.revision++; return { revoked: true };
    });
  }
}
