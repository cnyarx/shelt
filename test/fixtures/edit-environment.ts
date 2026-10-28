import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditAgent, EditSubmission } from "../../src/preview-edits.ts";

export async function editEnvironment(backend: "bun" | "rust", port: number, agentFixture?: string) {
  const directory = await mkdtemp(join(tmpdir(), "shelt-preview-edits-"));
  const state = join(directory, "state"), base = `http://127.0.0.1:${port}`;
  await mkdir(state); await mkdir(join(directory, "bin"));
  const fixture = agentFixture || new URL("./edit-agent.ts", import.meta.url).pathname;
  const herdr = join(directory, "bin", "herdr"), ssh = join(directory, "bin", "ssh");
  await writeFile(herdr, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`);
  await writeFile(ssh, '#!/bin/sh\nfor last do :; done\nexport EDIT_REMOTE=1\nexec /bin/sh -c "$last"\n');
  await chmod(herdr, 0o755); await chmod(ssh, 0o755);
  const path = join(directory, "document.md");
  const markdown = "# 发布方案\n\n## 更新\n\n发布完成后，手动重启所有服务。\n\n这一段包含 <特殊符号> & 引号。\n\n| 参数 | 默认值 |\n| --- | --- |\n| timeout | 30 秒 |\n";
  await writeFile(path, markdown);
  const htmlPath = join(directory, "page.html");
  await writeFile(htmlPath, '<!doctype html><html><head><title>HTML edit fixture</title></head><body><h1>HTML 文档</h1><section id="release"><h2>发布流程</h2><p id="instruction">请更新这里的部署说明。</p><table><tr><td>30 秒</td></tr></table><a id="test-link" href="#release">普通链接</a></section><script>document.body.dataset.ran="true"</script></body></html>');
  let control: Record<string, unknown> = {};
  const setControl = async (value: Record<string, unknown>) => { control = value; await writeFile(join(directory, "control.json"), JSON.stringify(value)); };
  await setControl({});
  const env = { ...process.env, HOME: directory, PATH: `${join(directory, "bin")}:${process.env.PATH}`, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: state, SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "herdr", SHELT_HERDR_BIN: herdr, SHELT_EDIT_FIXTURE: directory };
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">, cookie = "";
  const start = async () => {
    child = Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      await Bun.sleep(50);
    }
    throw new Error("Edit fixture server not ready");
  };
  const stop = async () => { child.kill(); await child.exited; };
  const login = async (setup = false) => {
    const response = await fetch(`${base}/api/auth/${setup ? "setup" : "login"}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "preview-edit-test-password" }) });
    if (!response.ok) throw new Error(`Fixture login failed ${response.status}`);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const api = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + url, { method, headers: { cookie, Origin: base, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const list = async (): Promise<EditAgent[]> => (await (await api(`/api/preview-edits/agents?path=${encodeURIComponent(path)}`)).json()).agents;
  const submission = (agent: EditAgent, id: string): EditSubmission => ({ requestId: id.repeat(32), targetId: agent.targetId, paneId: agent.paneId, session: agent.session, path, kind: "markdown", capturedAt: "2026-10-26T04:00:00.000Z", edits: [{ id: "edit-1", anchor: { text: "发布完成后，手动重启所有服务。", heading: "发布方案 > 更新", before: "更新", after: "下一段", locator: "p:nth-of-type(1)", lineStart: 5, lineEnd: 5 }, instruction: "改成滚动更新；保留已有修改。", replacement: "滚动更新 'quoted' \"double\" $(touch /tmp/shelt-edit-injection) <script>" }] });
  const received = async () => (await readFile(join(directory, "received.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  await start();
  return { directory, state, base, path, htmlPath, markdown, child: () => child, setControl, list, submission, api, received, login, start, stop, cleanup: async () => { await stop(); await rm(directory, { recursive: true, force: true }); }, cookie: () => cookie };
}
