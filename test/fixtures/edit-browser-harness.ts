import { editEnvironment } from "./edit-environment.ts";
import { readFile } from "node:fs/promises";

const env = await editEnvironment("rust", 24855);
const domTest = await Bun.build({ entrypoints: [new URL("../preview-edit-selection-dom.ts", import.meta.url).pathname], target: "browser", minify: false });
if (!domTest.success) throw new Error("DOM test build failed");
const control = Bun.serve({ hostname: "127.0.0.1", port: 24856, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/snapshot") return Response.json({ path: env.path, htmlPath: env.htmlPath, directory: env.directory, received: await env.received(), sourceUnchanged: await readFile(env.path, "utf8") === env.markdown });
  if (url.pathname === "/control" && req.method === "POST") { await env.setControl(await req.json() as Record<string, unknown>); return Response.json({ ok: true }); }
  if (url.pathname === "/dom-test.js") return new Response(domTest.outputs[0], { headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" } });
  return new Response("not found", { status: 404 });
} });
console.log(JSON.stringify({ page: env.base, control: String(control.url), path: env.path, htmlPath: env.htmlPath, pid: env.child().pid }));
const stop = async () => { control.stop(true); await env.cleanup(); process.exit(0); };
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
await new Promise(() => {});
