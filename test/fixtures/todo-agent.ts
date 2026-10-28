#!/usr/bin/env bun
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--session") args.splice(0, 2);
if (args[0] !== "agent" || args[1] !== "prompt") {
  await import("./edit-agent.ts");
} else {
  const directory = process.env.SHELT_EDIT_FIXTURE!;
  const control = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
  const receiptDir = join(process.env.SHELT_STATE_DIR!, "todo-delivery-receipts");
  const pending = await Promise.all((await readdir(receiptDir)).filter(f => f.endsWith(".json")).map(async f => JSON.parse(await readFile(join(receiptDir, f), "utf8"))));
  if (!pending.some(r => r.state === "pending")) throw new Error("Todo prompt arrived before durable receipt");
  const prompt = args[3]!;
  const token = prompt.match(/SHELT_TODO_TOKEN="([a-f0-9]{64})"/)?.[1];
  const base = prompt.match(/SHELT_TODO_BASE="([^"\n]+)"/)?.[1];
  if (!token || !base || new URL(base).hostname !== "127.0.0.1") throw new Error("Only isolated loopback todo targets are accepted");
  const calls: { method: string; path: string; status: number }[] = [];
  const api = async (path = "", method = "GET", body?: unknown) => {
    const response = await fetch(base + "/api/todos" + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    calls.push({ method, path, status: response.status });
    if (!response.ok) throw new Error(`Todo fixture API failed (${method} ${response.status})`);
    return response.json();
  };
  if (control.reject) { console.error(JSON.stringify({ error: { code: "agent_blocked" } })); process.exit(1); }
  if (control.executeTodos) {
    let snapshot = await api();
    const write = async (path: string, method: string, fields: Record<string, unknown>) => {
      const result = await api(path, method, { revision: snapshot.revision, ...(method === "POST" ? { requestId: crypto.randomUUID().replaceAll("-", "") } : {}), ...fields });
      snapshot = result.snapshot; return result.result;
    };
    let project = snapshot.projects[0];
    if (!project) project = await write("/projects", "POST", { title: "Agent API 项目" });
    await api("/projects"); await api(`/projects/${project.id}`); await api(`/projects/${project.id}/items`);
    await write(`/projects/${project.id}`, "PATCH", { description: "通过真实接口同步进展" });
    const folder = await write(`/projects/${project.id}/items`, "POST", { title: "Agent 同步清单", kind: "folder" });
    const task = await write(`/projects/${project.id}/items`, "POST", { title: "Agent 实际同步任务", kind: "task", parentId: folder.id });
    await api(`/items/${task.id}`);
    await write(`/items/${task.id}`, "PATCH", { status: "doing", description: "测试接收端已开始验证" });
    await write(`/items/${task.id}`, "PATCH", { status: "done", description: "真实 HTTP 调用及结果核对通过" });
    const scratch = await write(`/projects/${project.id}/items`, "POST", { title: "临时删除验证", kind: "task" });
    await write(`/items/${scratch.id}`, "DELETE", {});
    if (control.allScope) {
      const temporary = await write("/projects", "POST", { title: "临时项目" });
      await write(`/projects/${temporary.id}`, "PATCH", { title: "临时项目已重命名" });
      await write(`/projects/${temporary.id}`, "DELETE", {});
    }
  }
  await appendFile(join(directory, "todo-received.jsonl"), JSON.stringify({ remote: process.env.EDIT_REMOTE === "1", receiptWasPending: true, methods: calls, containsCurrentSnapshot: prompt.includes("revision"), containsEvidenceRules: prompt.includes("无证据保留原状态") }) + "\n");
  if (control.disconnect) process.exit(1);
  console.log(JSON.stringify({ result: { delivered: true } }));
}
