import { join } from "node:path";
import { editEnvironment } from "./edit-environment.ts";
import { mobileNative } from "./mobile-native.ts";

const port = Number(process.env.SHELT_MOBILE_TEST_PORT || 24912);
const env = await editEnvironment(process.env.SHELT_TEST_RUST ? "rust" : "bun", port, new URL("./mobile-agent.ts", import.meta.url).pathname,
  directory => ({ HERDR_SOCKET_PATH: join(directory, "native.sock") }));
const native = await mobileNative(env.directory);
await env.login(true);
const control = Bun.serve({ hostname: "127.0.0.1", port: port + 1, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/focus" && req.method === "POST") {
    const pane = url.searchParams.get("pane");
    if (!native.snapshot().agents.some(a => a.pane_id === pane)) return new Response("unknown pane", { status: 400 });
    native.focus(pane!); return Response.json({ ok: true });
  }
  return Response.json({ directory: env.directory, backendPid: env.child().pid, input: native.input, calls: native.calls, snapshot: native.snapshot(), terminalStarts: native.terminalStarts() });
} });
console.log(JSON.stringify({ page: env.base, control: `http://127.0.0.1:${port + 1}`, directory: env.directory, backendPid: env.child().pid }));
const stop = async () => { control.stop(true); await env.stop(); await native.close(); process.exit(0); };
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
await new Promise(() => {});
