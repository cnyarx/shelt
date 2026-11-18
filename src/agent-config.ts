import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrTarget } from "./targets.ts";
import type { LaunchTarget } from "./launch.ts";
import { nativeAgents, validPane, type NativeSnapshot } from "./mobile-model.ts";
import { nativeOnce } from "./mobile-service.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export type AgentConfigRow = { paneId: string; title: string; status: string; input: string | null };
export type AgentConfigOptions = { models: string[]; defaultModel: string; efforts: string[]; agents: AgentConfigRow[] };
export type AgentConfigResult = { paneId: string; title: string; ok: boolean; reason: string };
export type AgentConfigRequest = { panes: string[]; model?: string; effort?: string };

export function inputBoxText(screen: string): string | null {
  const lines = screen.split("\n");
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^╰.*╯\s*$/u.test(lines[i]!)) { bottom = i; break; }
  if (bottom < 0) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (/^╭.*╮\s*$/u.test(lines[i]!)) { top = i; break; }
  if (top < 0) return null;
  return lines.slice(top + 1, bottom).map(line => line.replace(/^│\s?/u, "").replace(/\s?│\s*$/u, "")).join("\n").trim();
}

export async function modelOptions(env = process.env): Promise<{ models: string[]; defaultModel: string }> {
  try {
    const settings = JSON.parse(await readFile(join(env.HOME || ".", ".qwen", "settings.json"), "utf8"));
    const providers = Array.isArray(settings?.modelProviders) ? settings.modelProviders : [];
    const ids = providers.map((provider: any) => (typeof provider?.id === "string" ? provider.id : "")).filter(Boolean);
    const defaultModel = typeof settings?.model?.name === "string" ? settings.model.name : "";
    return { models: [...new Set([...ids, ...(defaultModel ? [defaultModel] : [])])], defaultModel };
  } catch {
    return { models: [], defaultModel: "" };
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
  if (model !== undefined && (typeof model !== "string" || !MODEL_ID_PATTERN.test(model))) return "invalid_model";
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
  const { models, defaultModel } = await modelOptions(env);
  const agents = (await snapshotAgents(launch, target, env)).filter(agent => agent.kind === "qwen");
  const rows: AgentConfigRow[] = [];
  for (const agent of agents) {
    const read = await nativeOnce(launch, target, "pane.read", { pane_id: agent.paneId, source: "visible", format: "text", strip_ansi: true }, env) as { text?: string } | null;
    rows.push({ paneId: agent.paneId, title: agent.title, status: agent.status, input: read && typeof read.text === "string" ? inputBoxText(read.text) : null });
  }
  return { models, defaultModel, efforts: [...EFFORT_LEVELS], agents: rows };
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