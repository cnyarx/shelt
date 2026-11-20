import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrTarget } from "./targets.ts";
import type { LaunchTarget } from "./launch.ts";
import { nativeAgents, validPane, type NativeSnapshot } from "./mobile-model.ts";
import { nativeOnce } from "./mobile-service.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,120}$/;
const protocols = ["openai", "openai-responses", "anthropic", "gemini", "vertex-ai", "qwen-oauth", "qwen-subscription"];

export type ModelChoice = { id: string; name: string; provider: string; selector: string; multipleRoutes: boolean };
export type AgentConfigRow = { paneId: string; workspaceId: string; workspace: string; title: string; status: string; input: string | null };
export type AgentConfigOptions = { targetId: string; models: string[]; modelChoices: ModelChoice[]; defaultModel: string; efforts: string[]; agents: AgentConfigRow[] };
export type AgentConfigResult = { paneId: string; title: string; ok: boolean; reason: string };
export type AgentConfigRequest = { panes: string[]; model?: string; effort?: string };

export function inputBoxText(screen: string): string | null {
  const lines = screen.split("\n");
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^╰.*╯\s*$/u.test(lines[i]!)) { bottom = i; break; }
    if (!/^─{4,}\s*$/u.test(lines[i]!)) continue;
    const prompt = lines[i - 1]?.trimEnd() ?? "";
    if (!/^─{3,}(?: .* ──)?\s*$/u.test(lines[i - 2] ?? "") || !/^[>*](?: |$)/u.test(prompt)) return null;
    const text = prompt.slice(1);
    if (/^ {3}(?:Type your message or @path\/to\/file|输入您的消息或 @ 文件路径|Type your request, or \/usage|输入你的请求，或 \/usage)$/u.test(text)) return "";
    return text.trim();
  }
  if (bottom < 0) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (/^╭.*╮\s*$/u.test(lines[i]!)) { top = i; break; }
  if (top < 0) return null;
  return lines.slice(top + 1, bottom).map(line => line.replace(/^│\s?/u, "").replace(/\s?│\s*$/u, "")).join("\n").trim();
}

function validModelSelector(value: string): boolean {
  const parts = /^([^()]+)(?:\(([^()]+)\))?$/.exec(value);
  return !!parts && MODEL_ID_PATTERN.test(parts[1]!) && !parts[1]!.startsWith("--") && (!parts[2] || protocols.includes(parts[2]));
}

export async function modelOptions(env = process.env): Promise<Pick<AgentConfigOptions, "models" | "modelChoices" | "defaultModel">> {
  try {
    const settings = JSON.parse(await readFile(join(env.HOME || ".", ".qwen", "settings.json"), "utf8"));
    const providers = settings?.modelProviders;
    const groups = Array.isArray(providers) ? [["", providers] as const] : Object.entries(providers ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const choices = new Map<string, ModelChoice>();
    const declared = new Set<string>();
    for (const [provider, entries] of groups) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const id = entry?.id;
        if (typeof id !== "string" || !MODEL_ID_PATTERN.test(id) || id.startsWith("--")) continue;
        declared.add(id);
        if (["imageOnly", "realtimeOnly", "fastOnly", "voiceOnly", "visionOnly"].some(flag => entry[flag] === true)) continue;
        let protocol = settings.providerProtocol?.[provider] ?? provider;
        if (entry.wireApi !== undefined) {
          if (!["openai", "openai-responses"].includes(protocol) || !["responses", "chat-completions"].includes(entry.wireApi)) continue;
          protocol = entry.wireApi === "responses" ? "openai-responses" : "openai";
        }
        if (provider && !protocols.includes(protocol)) continue;
        const selector = protocol ? `${id}(${protocol})` : id;
        const prior = choices.get(selector);
        // /model takes an ID and protocol, not an endpoint. Don't promise a specific route on collision.
        if (prior) { prior.multipleRoutes = true; prior.name = id; if (prior.provider !== provider) prior.provider = protocol; continue; }
        choices.set(selector, { provider, id, name: typeof entry.name === "string" && entry.name ? entry.name : id, selector, multipleRoutes: false });
      }
    }
    const defaultModel = typeof settings?.model?.name === "string" ? settings.model.name : "";
    if (validModelSelector(defaultModel) && !declared.has(defaultModel) && !choices.has(defaultModel)) {
      choices.set(defaultModel, { id: defaultModel, name: defaultModel, provider: "", selector: defaultModel, multipleRoutes: false });
    }
    const modelChoices = [...choices.values()];
    return { models: [...new Set(modelChoices.map(m => m.id))], modelChoices, defaultModel };
  } catch {
    return { models: [], modelChoices: [], defaultModel: "" };
  }
}

export function validateAgentConfigRequest(body: Record<string, unknown> | null): AgentConfigRequest | string {
  if (!body || !Array.isArray(body.panes) || body.panes.length < 1 || body.panes.length > 64) return "panes_required";
  const panes: string[] = [];
  for (const pane of body.panes) {
    if (typeof pane !== "string" || !validPane(pane)) return "invalid_pane";
    panes.push(pane);
  }
  const model = body.model === undefined || body.model === "" ? undefined : body.model;
  const effort = body.effort === undefined || body.effort === "" ? undefined : body.effort;
  if (model !== undefined && (typeof model !== "string" || !validModelSelector(model))) return "invalid_model";
  if (effort !== undefined && (typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort))) return "invalid_effort";
  if (model === undefined && effort === undefined) return "nothing_to_apply";
  return { panes, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

async function snapshotAgents(launch: LaunchTarget, target: HerdrTarget | null, env: NodeJS.ProcessEnv) {
  const result = await nativeOnce(launch, target, "session.snapshot", {}, env) as { snapshot?: NativeSnapshot } | NativeSnapshot | null;
  const snapshot = (result && "snapshot" in result && result.snapshot ? result.snapshot : result) as NativeSnapshot | null;
  return snapshot ? nativeAgents(snapshot) : [];
}

export async function agentConfigOptions(launch: LaunchTarget, target: HerdrTarget | null, env = process.env): Promise<AgentConfigOptions> {
  const catalog = await modelOptions(env);
  const agents = (await snapshotAgents(launch, target, env)).filter(agent => agent.kind === "qwen");
  const rows: AgentConfigRow[] = [];
  for (const agent of agents) {
    const read = await nativeOnce(launch, target, "pane.read", { pane_id: agent.paneId, source: "visible", format: "text", strip_ansi: true }, env) as { read?: { text?: string } } | null;
    const text = read?.read?.text;
    rows.push({ paneId: agent.paneId, title: agent.title, workspaceId: agent.workspaceId, workspace: agent.workspace, status: agent.status, input: typeof text === "string" ? inputBoxText(text) : null });
  }
  return { ...catalog, targetId: target?.id ?? "local", efforts: [...EFFORT_LEVELS], agents: rows };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function applyAgentConfig(launch: LaunchTarget, target: HerdrTarget | null, request: AgentConfigRequest, env = process.env): Promise<AgentConfigResult[]> {
  const agents = await snapshotAgents(launch, target, env);
  const results: AgentConfigResult[] = [];
  for (const paneId of request.panes) {
    const agent = agents.find(candidate => candidate.paneId === paneId);
    if (!agent) { results.push({ paneId, title: paneId, ok: false, reason: "agent_not_found" }); continue; }
    if (agent.kind !== "qwen") { results.push({ paneId, title: agent.title, ok: false, reason: "not_qwen" }); continue; }
    if (agent.status !== "idle" && agent.status !== "done") { results.push({ paneId, title: agent.title, ok: false, reason: `status_${agent.status}` }); continue; }
    let ok = true;
    let reason = "sent";
    if (request.model) {
      const sent = await nativeOnce(launch, target, "pane.send_input", { pane_id: paneId, text: `/model ${request.model}`, keys: ["Enter"] }, env);
      if (!sent) { ok = false; reason = "send_failed"; }
    }
    if (ok && request.effort) {
      await sleep(150);
      const sent = await nativeOnce(launch, target, "pane.send_input", { pane_id: paneId, text: `/effort ${request.effort}`, keys: ["Enter"] }, env);
      if (!sent) { ok = false; reason = "send_failed"; }
    }
    results.push({ paneId, title: agent.title, ok, reason });
    await sleep(150);
  }
  return results;
}