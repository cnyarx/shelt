const result = await Bun.build({ entrypoints: [new URL("./link-client.ts", import.meta.url).pathname], target: "browser", minify: false });
if (!result.success) throw new AggregateError(result.logs, "Link fixture build failed");
const js = result.outputs.find((output) => output.path.endsWith(".js"))!;
const css = result.outputs.find((output) => output.path.endsWith(".css"))!;
const server = Bun.serve({ hostname: "127.0.0.1", port: 24844, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/client.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/client.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
  if (path === "/review/30457150") return new Response("OSC 8 link opened successfully", { headers: { "Content-Type": "text/plain" } });
  return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Shelt link regression</title><link rel="stylesheet" href="/client.css"><style>body{background:#000;color:#ddd;margin:20px}#terminal{width:max-content}</style></head><body><h1>OSC 8 / TUI redraw regression</h1><div id="terminal"></div><script type="module" src="/client.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
} });
console.log(`Link regression fixture: ${server.url}`);
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
