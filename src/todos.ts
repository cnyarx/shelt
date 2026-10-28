export const TODO_STATES = ["todo", "doing", "blocked", "done", "canceled"] as const;
export type TodoStatus = typeof TODO_STATES[number];
export type TodoProject = { id: string; title: string; description: string; order: number; revision: number };
export type TodoItem = TodoProject & { projectId: string; parentId: string | null; kind: "folder" | "task"; status: TodoStatus | null };
export type TodoGrant = { id: string; hash: string; projectId: string | null; expiresAt: number; revoked: boolean };
export type TodoData = { version: 1; revision: number; projects: TodoProject[]; items: TodoItem[]; tokens: TodoGrant[]; receipts: Record<string, { digest: string; result: unknown }> };
export type TodoView = Pick<TodoData, "revision" | "projects" | "items">;
export type TodoActor = { scope: string | null; grantId: string | null };
export class TodoError extends Error { constructor(public status: number, public code: string) { super(code); } }
export function todoFail(status: number, code: string): never { throw new TodoError(status, code); }
export const emptyTodos = (): TodoData => ({ version: 1, revision: 0, projects: [], items: [], tokens: [], receipts: {} });
export const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const text = (value: unknown, max: number, required = false): value is string => typeof value === "string" && [...value].length <= max && (!required || !!value.trim()) && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
export function todoView(data: TodoData, scope: string | null): TodoView {
  return { revision: data.revision, projects: data.projects.filter(p => scope === null || p.id === scope), items: data.items.filter(i => scope === null || i.projectId === scope) };
}
export function checkTodoTree(data: TodoData): void {
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.projects) || !Array.isArray(data.items) || !Array.isArray(data.tokens) || !data.receipts || typeof data.receipts !== "object") throw new Error("Invalid todo data");
  const projects = new Set(data.projects.map(p => p.id)), ids = new Set<string>();
  for (const node of [...data.projects, ...data.items]) {
    if (!validId(node.id) || ids.has(node.id) || !text(node.title, 160, true) || !text(node.description, 8000) || !Number.isSafeInteger(node.order) || !Number.isSafeInteger(node.revision)) todoFail(400, "invalid_node");
    ids.add(node.id);
  }
  for (const item of data.items) {
    if (!projects.has(item.projectId) || !["task", "folder"].includes(item.kind) || (item.kind === "folder" ? item.status !== null : !TODO_STATES.includes(item.status!))) todoFail(400, "invalid_node");
    let current = item; const seen = new Set([item.id]); let depth = 0;
    while (current.parentId !== null) {
      const parent = data.items.find(i => i.id === current.parentId);
      if (!parent || parent.kind !== "folder" || parent.projectId !== item.projectId || seen.has(parent.id) || ++depth > 16) todoFail(400, "invalid_parent");
      seen.add(parent.id); current = parent;
    }
  }
}
export function todoSummary(items: TodoItem[], root?: string) {
  const chosen = root ? descendants(items, root).concat(root) : items.map(i => i.id);
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0, canceled: 0 };
  for (const item of items) if (chosen.includes(item.id) && item.kind === "task") counts[item.status!]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0), active = total - counts.canceled;
  const status = counts.doing ? "doing" : counts.blocked ? "blocked" : counts.todo ? "todo" : counts.done ? "done" : counts.canceled ? "canceled" : "empty";
  return { ...counts, total, active, remaining: active - counts.done, status };
}
export function descendants(items: TodoItem[], id: string): string[] {
  const result: string[] = [], queue = [id];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of items.filter(i => i.parentId === parent)) { result.push(child.id); queue.push(child.id); }
  }
  return result;
}
export function todoMutation(data: TodoData, actor: TodoActor, method: string, path: string[], body: Record<string, any>, id: string): unknown {
  const [resource, key, child] = path;
  const project = key && resource === "projects" ? data.projects.find(p => p.id === key) : undefined;
  const item = key && resource === "items" ? data.items.find(i => i.id === key) : undefined;
  const scope = item?.projectId ?? project?.id;
  if (key && !(project || item)) todoFail(404, "not_found");
  if (actor.scope !== null && (scope !== actor.scope || resource === "projects" && !key)) todoFail(403, "scope_forbidden");
  const creatingProject = resource === "projects" && !key && method === "POST";
  const creatingItem = resource === "projects" && !!project && child === "items" && method === "POST";
  const allowed = new Set(["revision", ...(creatingProject || creatingItem ? ["requestId"] : []), ...(method === "DELETE" ? ["recursive"] : ["title", "description", "order", ...(creatingItem ? ["kind", "parentId", "status"] : item ? ["projectId", "parentId", "status"] : [])])]);
  if (Object.keys(body).some(k => !allowed.has(k))) todoFail(400, "unknown_field");
  if ((body.title !== undefined && !text(body.title, 160, true)) || (body.description !== undefined && !text(body.description, 8000)) || (body.order !== undefined && !Number.isSafeInteger(body.order))) todoFail(400, "invalid_node");
  if (creatingProject) {
    if (!text(body.title, 160, true)) todoFail(400, "invalid_title");
    const p = { id, title: body.title.trim(), description: body.description ?? "", order: body.order ?? data.projects.length, revision: data.revision + 1 };
    data.projects.push(p); return p;
  }
  if (creatingItem) {
    if (!text(body.title, 160, true) || !["folder", "task"].includes(body.kind)) todoFail(400, "invalid_node");
    const n: TodoItem = { id, title: body.title.trim(), description: body.description ?? "", order: body.order ?? data.items.length, revision: data.revision + 1, projectId: project!.id, parentId: body.parentId ?? null, kind: body.kind, status: body.kind === "folder" ? null : body.status ?? "todo" };
    if (body.kind === "folder" && body.status != null) todoFail(400, "folder_has_no_status");
    data.items.push(n); checkTodoTree(data); return n;
  }
  const node = item ?? project;
  if (!node || child || !["PATCH", "DELETE"].includes(method)) todoFail(404, "not_found");
  if (method === "DELETE") {
    const removed = item ? descendants(data.items, item.id) : data.items.filter(i => i.projectId === project!.id).map(i => i.id);
    if (removed.length && body.recursive !== true) todoFail(409, "confirmation_required");
    if (item) removed.push(item.id);
    data.items = data.items.filter(i => !removed.includes(i.id));
    if (project) data.projects = data.projects.filter(p => p.id !== project.id);
    return { deleted: node.id, count: removed.length };
  }
  if (item) {
    if (body.status !== undefined && (item.kind !== "task" || !TODO_STATES.includes(body.status))) todoFail(400, "invalid_status");
    if (body.parentId !== undefined && body.parentId !== null && !validId(body.parentId)) todoFail(400, "invalid_parent");
    if (body.projectId !== undefined) {
      if (!data.projects.some(p => p.id === body.projectId)) todoFail(400, "invalid_project");
      if (actor.scope !== null && body.projectId !== actor.scope) todoFail(403, "scope_forbidden");
      if (body.projectId !== item.projectId) {
        for (const childId of descendants(data.items, item.id)) { const n = data.items.find(i => i.id === childId)!; n.projectId = body.projectId; n.revision = data.revision + 1; }
        item.projectId = body.projectId; item.parentId = null;
      }
    }
    if (body.parentId !== undefined) item.parentId = body.parentId;
    if (body.status !== undefined) item.status = body.status;
  }
  for (const field of ["title", "description", "order"] as const) if (body[field] !== undefined) (node as any)[field] = field === "title" ? body[field].trim() : body[field];
  node.revision = data.revision + 1; checkTodoTree(data); return node;
}

export function todoPrompt(base: string, token: string, scope: string | null, expiresAt: number, view: TodoView): string {
  const project = scope ?? "<projectId>";
  return [
    "请根据当前工作真实进展维护 Shelt 待办。先查询，再复用已有项目和任务更新；无证据保留原状态，描述依据。不得将收到本提示词当作完成证据。",
    `API 根地址：${base}/api/todos；授权范围：${scope ?? "全清单（用户明确授权）"}；到期：${new Date(expiresAt).toISOString()}。若目标不可达请报告，不自行建隧道。`,
    "仅任务叶子有 todo/doing/blocked/done/canceled 状态；folder 是组织节点，status=null。父级汇总。支持重开和取消；创建前查重。PATCH/DELETE 使用最新全局 revision，409时重新查询，POST使用新的32位小写hex requestId且重试沿用同ID。非空删除需用户明确要求并传recursive:true。不要删除无关待办。",
    "将下面临时令牌仅用于 Authorization: Bearer 头，不写入URL、日志、文件、提交或最终答复，不转交其他服务。HTTP仅适用于受信内网，公网使用HTTPS。",
    `export SHELT_TODO_BASE=${JSON.stringify(base)}\nexport SHELT_TODO_TOKEN=${JSON.stringify(token)}`,
    'curl -fsS "$SHELT_TODO_BASE/api/todos" -H "Authorization: Bearer $SHELT_TODO_TOKEN"',
    `curl -fsS "$SHELT_TODO_BASE/api/todos/projects" -H "Authorization: Bearer $SHELT_TODO_TOKEN"\ncurl -fsS "$SHELT_TODO_BASE/api/todos/projects/${project}/items" -H "Authorization: Bearer $SHELT_TODO_TOKEN"`,
    '写操作示例（替换revision、ID及要求；所有写请求带 -H "Content-Type: application/json" -H "Authorization: Bearer $SHELT_TODO_TOKEN"）：',
    'POST /api/todos/projects {"revision":0,"requestId":"<32hex>","title":"项目"}（仅全清单授权可创建项目）',
    `POST /api/todos/projects/${project}/items {"revision":0,"requestId":"<32hex>","kind":"task","title":"任务","parentId":null,"status":"todo"}`,
    'POST同路径可创建 {"kind":"folder",...}；GET /api/todos/projects/{id} 或 /api/todos/items/{id} 获取单项。',
    'PATCH /api/todos/projects/{id} {"revision":1,"title":"项目名称"}；PATCH /api/todos/items/{id} {"revision":2,"status":"doing","description":"进展依据"}；移动时传parentId、projectId、order。',
    'DELETE /api/todos/items/{id} 或 /api/todos/projects/{id} {"revision":3,"recursive":true}；任务叶子删除无需recursive。',
    "当前快照仅供参考，执行前必须重新GET：",
    JSON.stringify(view, null, 2),
  ].join("\n\n");
}
