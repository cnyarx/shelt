import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "shelt-native-herdr-"));
const config = join(directory, ".config/herdr");
await mkdir(config, { recursive: true, mode: 0o700 });
await writeFile(join(config, "config.toml"), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_") && !key.startsWith("SHELT_")));
Object.assign(env, { HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), HERDR_CONFIG_PATH: join(config, "config.toml"), SHELL: "/bin/bash", TERM: "xterm-256color", LANG: "C.UTF-8" });
const herdr = process.env.SHELT_NATIVE_HERDR_BIN || "/home/admin/bin/herdr";
let herdrLog = "", sheltLog = "";
const server = Bun.spawn([herdr, "server"], { env, cwd: directory, stdout: "pipe", stderr: "pipe" });
const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => { const decoder = new TextDecoder(); for await (const chunk of stream) append(decoder.decode(chunk)); };
void drain(server.stdout, text => { herdrLog = (herdrLog + text).slice(-4000); });
void drain(server.stderr, text => { herdrLog = (herdrLog + text).slice(-4000); });
const rpc = async (...args: string[]) => {
  const command = Bun.spawn([herdr, ...args], { env, cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
  if (exit) throw new Error(`Isolated Herdr ${args.join(" ")} failed: ${stderr}`);
  if (!stdout.trim()) {
    if ((args[0] === "pane" && args[1] === "report-agent") || (args[0] === "server" && args[1] === "stop")) return {};
    throw new Error(`Isolated Herdr returned empty JSON for ${args.join(" ")}: ${stderr}`);
  }
  return JSON.parse(stdout).result;
};
let shelt: Bun.Subprocess | undefined, terminal: Bun.Subprocess | undefined, control: ReturnType<typeof Bun.serve> | undefined;
const stop = async () => {
  control?.stop(true); terminal?.kill(); shelt?.kill();
  if (shelt) await shelt.exited;
  try { await rpc("server", "stop"); } catch { server.kill(); }
  await server.exited;
};
try {
  let snapshot: any;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(herdrLog);
    try { snapshot = (await rpc("api", "snapshot")).snapshot; break; } catch {}
    await Bun.sleep(50);
  }
  if (!snapshot) throw new Error(`Isolated Herdr did not start: ${herdrLog}`);
  if (!snapshot.workspaces.length) { await rpc("workspace", "create", "--label", "手机同步验收", "--cwd", directory); snapshot = (await rpc("api", "snapshot")).snapshot; }
  const workspace = snapshot.workspaces[0].workspace_id;
  const firstPane = snapshot.panes[0].pane_id;
  const second = await rpc("tab", "create", "--workspace", workspace, "--cwd", directory, "--label", "第二个测试终端", "--no-focus");
  const secondPane = second.root_pane.pane_id;
  for (const pane of [firstPane, secondPane]) {
    await rpc("pane", "report-agent", pane, "--source", "shelt-native-test", "--agent", "qwen", "--state", "idle");
  }
  await rpc("agent", "focus", firstPane);
  const state = join(directory, "shelt-state"); await mkdir(state, { mode: 0o700 });
  const bin = join(directory, "bin"); await mkdir(bin);
  const wrapper = join(bin, "herdr");
  await writeFile(wrapper, `#!/bin/sh\nexec '${herdr}' "$@"\n`); await chmod(wrapper, 0o755);
  const base = "http://127.0.0.1:24916";
  const sheltEnv = { ...env, PATH: `${bin}:${env.PATH}`, SHELT_HOST: "127.0.0.1", SHELT_PORT: "24916", SHELT_PUBLIC_HOSTS: "127.0.0.1:24916,localhost:24916", SHELT_STATE_DIR: state, SHELT_UPLOAD_DIR: join(state, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_MODE: "herdr", SHELT_HERDR_BIN: wrapper };
  shelt = Bun.spawn([join(import.meta.dir, "../../target/debug/shelt"), "foreground"], { env: sheltEnv, cwd: directory, stdout: "pipe", stderr: "pipe" });
  void drain(shelt.stdout as ReadableStream<Uint8Array>, text => { sheltLog = (sheltLog + text).slice(-4000); });
  void drain(shelt.stderr as ReadableStream<Uint8Array>, text => { sheltLog = (sheltLog + text).slice(-4000); });
  for (let i = 0; i < 100; i++) {
    if (shelt.exitCode !== null) throw new Error(sheltLog);
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    await Bun.sleep(50);
  }
  const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "native-test-password" }) });
  if (!setup.ok) throw new Error("Isolated Shelt setup failed");
  let nativeScreen = "";
  terminal = Bun.spawn([herdr], { env, cwd: directory, terminal: { cols: 100, rows: 30, data(_, bytes) { nativeScreen = (nativeScreen + new TextDecoder().decode(bytes)).slice(-200000); } } });
  control = Bun.serve({ hostname: "127.0.0.1", port: 24917, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/focus" && req.method === "POST") {
      const pane = url.searchParams.get("pane"); if (![firstPane, secondPane].includes(pane)) return new Response("unknown test pane", { status: 400 });
      return Response.json(await rpc("agent", "focus", pane!));
    }
    if (url.pathname === "/native-input" && req.method === "POST") {
      const body = await req.json() as { text?: string };
      if (typeof body.text !== "string" || body.text.length > 1000) return new Response("invalid input", { status: 400 });
      terminal!.terminal!.write(body.text); return Response.json({ ok: true });
    }
    if (url.pathname === "/snapshot") return Response.json((await rpc("api", "snapshot")).snapshot);
    return Response.json({ directory, herdrPid: server.pid, sheltPid: shelt!.pid, nativeClientPid: terminal!.pid, firstPane, secondPane, nativeScreen, herdrLog, sheltLog });
  } });
  console.log(JSON.stringify({ page: base, control: "http://127.0.0.1:24917", directory, herdrPid: server.pid, sheltPid: shelt.pid, nativeClientPid: terminal.pid, firstPane, secondPane }));
  process.on("SIGTERM", () => { void stop().then(() => process.exit(0)); });
  process.on("SIGINT", () => { void stop().then(() => process.exit(0)); });
  await new Promise(() => {});
} catch (error) { await stop(); throw error; }
