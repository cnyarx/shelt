import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchTarget } from "./launch.ts";
import { herdrPaneEnvironment } from "./launch.ts";
import type { HerdrTarget } from "./targets.ts";
import { agentReady, buildEditPrompt, type EditAgent, type EditSubmission } from "./preview-edits.ts";

export const MAX_EDIT_BODY = 256 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
type Delivery = { state?: "pending" | "sent" | "uncertain"; error?: string };
type Receipt = Delivery & { digest: string };
type RawAgent = Record<string, unknown>;

export class PreviewEditService {
  private readonly running = new Set<string>();
  private readonly busy = new Set<string>();
  constructor(private launch: LaunchTarget, private directory: string, private env = process.env) {}

  private async command(target: HerdrTarget | null, args: string[], prompt?: string): Promise<Record<string, any>> {
    const env = herdrPaneEnvironment(this.env);
    const command = target ? ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", target.remote,
      `PATH="$HOME/bin:$HOME/.local/bin:$PATH"; export PATH; exec herdr ${target.session ? `--session ${quote(target.session)} ` : ""}${args.map(quote).join(" ")}${prompt === undefined ? "" : ' "$(cat)"'}`] : [this.launch.command, ...args, ...(prompt === undefined ? [] : [prompt])];
    if (!target && this.launch.mode !== "herdr") throw new Error("unavailable");
    const child = Bun.spawn(command, { env, stdin: target && prompt !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    if (target && prompt !== undefined) { child.stdin!.write(prompt); child.stdin!.end(); }
    const timer = setTimeout(() => child.kill(), 8000);
    const bounded = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1024 * 1024) { child.kill(); throw new Error("unavailable"); } chunks.push(next.value); }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const [stdout, stderr, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
      let result: Record<string, any>;
      try { result = JSON.parse(code === 0 ? stdout : stderr); } catch { throw new Error("unavailable"); }
      if (code !== 0 || !result.result || result.error) throw new Error(result.error?.code === "agent_blocked" ? "agent_busy" : "unavailable");
      return result.result;
    } finally { clearTimeout(timer); }
  }

  private agent(raw: RawAgent, target: HerdrTarget | null): EditAgent | null {
    const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
    const paneId = text("pane_id"), terminal = text("terminal_id");
    if (!paneId || !terminal || !text("agent")) return null;
    const native = raw.agent_session && typeof raw.agent_session === "object" ? raw.agent_session as Record<string, unknown> : {};
    const session = hash([target?.remote || "local", target?.session || "", paneId, terminal, text("workspace_id"), text("tab_id"), text("agent"), String(native.value || "")].join("\0"));
    return { targetId: target?.id || "local", connection: target?.name || "本机 Herdr", paneId, workspace: text("workspace_id"), title: text("terminal_title_stripped") || text("title") || text("name") || text("agent"), cwd: text("foreground_cwd") || text("cwd"), status: raw.launch_pending ? "unknown" : text("agent_status"), session };
  }

  private async namedAgents(target: HerdrTarget | null): Promise<EditAgent[]> {
    const result = await this.command(target, ["agent", "list"]);
    if (!Array.isArray(result.agents)) return [];
    const workspaces = await this.command(target, ["workspace", "list"]).catch(() => ({ workspaces: [] }));
    return result.agents.map((raw: RawAgent) => {
      const agent = this.agent(raw, target);
      if (!agent) return null;
      const workspace = workspaces.workspaces?.find((w: RawAgent) => w.workspace_id === raw.workspace_id);
      agent.workspace = workspace?.label || agent.cwd.split("/").filter(Boolean).at(-1) || "Workspace";
      return agent;
    }).filter((a: EditAgent | null): a is EditAgent => !!a);
  }

  async source(target: HerdrTarget | null): Promise<{ agent: EditAgent | null; cwd: string | null }> {
    try {
      const result = await this.command(target, ["pane", "current"]);
      const pane = result.pane;
      const cwd = pane?.foreground_cwd || pane?.cwd || null;
      const agents = await this.namedAgents(target);
      const agent = agents.find(a => a.paneId === pane?.pane_id) || null;
      return { agent, cwd };
    } catch { return { agent: null, cwd: null }; }
  }

  async list(targets: HerdrTarget[]): Promise<EditAgent[]> {
    return (await Promise.all([null, ...targets].map(target => this.namedAgents(target).catch(() => [])))).flat();
  }

  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
  private async store(file: string, receipt: Receipt): Promise<void> {
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp, file); await this.syncDirectory(); } catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  private async previous(file: string, digest: string, id: string): Promise<Delivery | null> {
    try {
      const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (receipt.digest !== digest) return { error: "request_conflict" };
      return receipt.state === "pending" ? { state: this.running.has(id) ? "pending" : "uncertain" } : { ...(receipt.state ? { state: receipt.state } : {}), ...(receipt.error ? { error: receipt.error } : {}) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async send(body: EditSubmission, target: HerdrTarget | null): Promise<Delivery> {
    if (Buffer.byteLength(buildEditPrompt(body)) > 60 * 1024) return { error: "too_large" };
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    const digest = hash(JSON.stringify(body)), file = join(this.directory, `${body.requestId}.json`);
    const previous = await this.previous(file, digest, body.requestId); if (previous) return previous;
    const lock = `${body.targetId}:${body.paneId}`;
    if (this.busy.has(lock)) return { error: "agent_busy" };
    this.busy.add(lock);
    try {
      let agents: EditAgent[];
      try {
        const result = await this.command(target, ["agent", "list"]);
        agents = (result.agents || []).map((a: RawAgent) => this.agent(a, target)).filter(Boolean);
      } catch { return { error: "unavailable" }; }
      const agent = agents.find(a => a.paneId === body.paneId);
      if (!agent || agent.session !== body.session) return { error: "agent_changed" };
      if (!agentReady(agent.status)) return { error: "agent_busy" };
      let handle;
      try { handle = await open(file, "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return await this.previous(file, digest, body.requestId) || { state: "uncertain" }; throw e; }
      this.running.add(body.requestId);
      try {
        try { await handle.writeFile(JSON.stringify({ digest, state: "pending" })); await handle.sync(); await this.syncDirectory(); }
        finally { await handle.close(); }
        let delivery: Delivery;
        try { await this.command(target, ["agent", "prompt", body.paneId], buildEditPrompt(body)); delivery = { state: "sent" }; }
        catch (e) { delivery = (e as Error).message === "agent_busy" ? { error: "agent_busy" } : { state: "uncertain" }; }
        try { await this.store(file, { digest, ...delivery }); } catch { return { state: "uncertain" }; }
        return delivery;
      } finally { this.running.delete(body.requestId); }
    } finally { this.busy.delete(lock); }
  }
}
