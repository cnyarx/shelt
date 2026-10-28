import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { editEnvironment } from "./edit-environment.ts";

const env = await editEnvironment("rust", 24866, new URL("./todo-agent.ts", import.meta.url).pathname);
let stopped = false;
const received = async () => (await readFile(join(env.directory, "todo-received.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const control = Bun.serve({ hostname: "127.0.0.1", port: 24867, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/snapshot") return Response.json({ page: env.base, directory: env.directory, backendPid: env.child().pid, received: await received(), sourceUnchanged: await readFile(env.path, "utf8") === env.markdown });
  if (url.pathname === "/control" && req.method === "POST") { await env.setControl(await req.json() as Record<string, unknown>); return Response.json({ ok: true }); }
  if (url.pathname === "/restart" && req.method === "POST") { await env.stop(); await env.start(); return Response.json({ ok: true, backendPid: env.child().pid }); }
  if (url.pathname === "/stop" && req.method === "POST" && !stopped) { stopped = true; await env.stop(); return Response.json({ stopped: true }); }
  if (url.pathname === "/start" && req.method === "POST" && stopped) { await env.start(); stopped = false; return Response.json({ started: true }); }
  return new Response("not found", { status: 404 });
} });
console.log(JSON.stringify({ page: env.base, control: String(control.url), directory: env.directory, backendPid: env.child().pid }));
const stop = async () => { control.stop(true); if (!stopped) await env.stop(); process.exit(0); };
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
await new Promise(() => {});
