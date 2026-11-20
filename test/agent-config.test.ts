import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputBoxText, modelOptions, validateAgentConfigRequest, EFFORT_LEVELS } from "../src/agent-config.ts";
import { nativeRequest } from "../src/mobile-service.ts";
import { editEnvironment } from "./fixtures/edit-environment.ts";
import { mobileNative } from "./fixtures/mobile-native.ts";

const EMPTY_BOX = "╭────────╮\n│        │\n╰────────╯";
const DRAFT_BOX = "╭────────╮\n│ hello  │\n╰────────╯";

test("input box extraction distinguishes empty, draft and unreadable screens", () => {
  expect(inputBoxText(`output line\n${EMPTY_BOX}\n`)).toBe("");
  expect(inputBoxText(`output line\n${DRAFT_BOX}\n`)).toBe("hello");
  expect(inputBoxText("plain bash screen without borders")).toBeNull();
  expect(inputBoxText("╭──╮\n│ a │\n│ b │\n╰──╯")).toBe("a\nb");
});

test("model options come from settings provider ids plus the default model", async () => {
  const home = await mkdtemp(join(tmpdir(), "shelt-agent-config-"));
  await mkdir(join(home, ".qwen"), { recursive: true });
  await writeFile(join(home, ".qwen", "settings.json"), JSON.stringify({ modelProviders: [{ id: "prov-a" }, { id: "prov-b" }, { id: "prov-a" }], model: { name: "default-c" } }));
  const options = await modelOptions({ HOME: home } as NodeJS.ProcessEnv);
  expect(options.models).toEqual(["prov-a", "prov-b", "default-c"]);
  expect(options.modelChoices.map(choice => choice.selector)).toEqual(options.models);
  expect(await modelOptions({ HOME: join(home, "missing") } as NodeJS.ProcessEnv)).toEqual({ models: [], modelChoices: [], defaultModel: "" });
});

test("apply request validation bounds panes, model ids and effort levels", () => {
  expect(validateAgentConfigRequest({ panes: ["w1:p1"], model: "prov-a", effort: "high" })).toEqual({ panes: ["w1:p1"], model: "prov-a", effort: "high" });
  expect(validateAgentConfigRequest({ panes: ["w1:p1"], model: "", effort: "" })).toBe("nothing_to_apply");
  expect(validateAgentConfigRequest({ panes: [], model: "x" })).toBe("panes_required");
  expect(validateAgentConfigRequest({ panes: ["bad pane"], model: "x" })).toBe("invalid_pane");
  expect(validateAgentConfigRequest({ panes: ["w1:p1"], model: "has space" })).toBe("invalid_model");
  expect(validateAgentConfigRequest({ panes: ["w1:p1"], effort: "ultra" })).toBe("invalid_effort");
  expect(validateAgentConfigRequest(null)).toBe("panes_required");
  expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("native allowlist accepts bounded send_input and visible pane.read only", () => {
  const call = (method: string, params: object) => nativeRequest(JSON.stringify({ id: "t:1", method, params }));
  expect(call("pane.send_input", { pane_id: "w1:p1", text: "/model prov-a", keys: ["Enter"] })).toContain("pane.send_input");
  expect(call("pane.send_input", { pane_id: "w1:p1", text: "x", keys: ["Esc"] })).toBeNull();
  expect(call("pane.send_input", { pane_id: "w1:p1", text: "a\rb", keys: [] })).toBeNull();
  expect(call("pane.send_input", { pane_id: "w1:p1", text: "x".repeat(4001), keys: [] })).toBeNull();
  expect(call("pane.read", { pane_id: "w1:p1", source: "visible", format: "text" })).toContain("pane.read");
  expect(call("pane.read", { pane_id: "w1:p1", source: "recent", format: "text" })).toBeNull();
  expect(call("pane.read", { pane_id: "w1:p1", source: "visible", format: "text", lines: 5000 })).toBeNull();
});

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] as const : ["bun"] as const) {
  test(`${backend}: agent config options preview input boxes and apply skips non-idle agents`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24918 : 24919, new URL("./fixtures/mobile-agent.ts", import.meta.url).pathname, directory => ({ HERDR_SOCKET_PATH: join(directory, "native.sock") }));
    const native = await mobileNative(env.directory);
    try {
      await env.login(true);
      const scriptSettings = { modelProviders: {
        openai: [{ id: "org/chat", name: "Chat" }, { id: "repeat", name: "A" }, { id: "repeat", name: "B" }, { id: "speech", realtimeOnly: true }, { id: "draw", imageOnly: true }, { id: "responses", wireApi: "responses" }],
        vendor: [{ id: "org/chat", name: "Other", envKey: "PRIVATE_FIELD", baseUrl: "https://fixture.test" }],
      }, providerProtocol: { vendor: "anthropic" }, model: { name: "org/chat" } };
      await mkdir(join(env.directory, ".qwen"), { recursive: true });
      await writeFile(join(env.directory, ".qwen/settings.json"), JSON.stringify(scriptSettings));
      const snapshot = native.snapshot();
      native.replace({ ...snapshot, workspaces: [{ workspace_id: "w2", label: "Same" }, { workspace_id: "w1", label: "Same" }], agents: [...snapshot.agents, { ...snapshot.agents[0]!, workspace_id: "w2", pane_id: "w2:p3", agent_status: "done" }] });
      native.setScreen("w1:p1", "───── report ──\n*   Type your message or @path/to/file\n─────────\nstatus");
      native.setScreen("w1:p2", DRAFT_BOX);
      expect((await fetch(`${env.base}/api/agent-config/options`)).status).toBe(401);
      const options = await (await env.api("/api/agent-config/options")).json();
      expect(options.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(options.targetId).toBe("local");
      expect((await env.api("/api/agent-config/apply", "POST", { targetId: "previous", panes: ["w1:p1"], model: "org/chat(anthropic)" })).status).toBe(409);
      expect(options.models).toEqual(["org/chat", "repeat", "responses"]);
      expect(options.modelChoices).toEqual([
        { provider: "openai", id: "org/chat", name: "Chat", selector: "org/chat(openai)", multipleRoutes: false },
        { provider: "openai", id: "repeat", name: "repeat", selector: "repeat(openai)", multipleRoutes: true },
        { provider: "openai", id: "responses", name: "responses", selector: "responses(openai-responses)", multipleRoutes: false },
        { provider: "vendor", id: "org/chat", name: "Other", selector: "org/chat(anthropic)", multipleRoutes: false },
      ]);
      expect(options.agents.map((a: any) => [a.paneId, a.workspaceId, a.workspace, a.status, a.input])).toEqual([
        ["w2:p3", "w2", "Same", "done", null],
        ["w1:p1", "w1", "Same", "idle", ""],
        ["w1:p2", "w1", "Same", "blocked", "hello"],
      ]);
      const applied = await (await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1", "w1:p2"], model: "org/chat(anthropic)", effort: "high" })).json();
      expect(applied.results).toEqual([
        { paneId: "w1:p1", title: options.agents[1].title, ok: true, reason: "sent" },
        { paneId: "w1:p2", title: options.agents[2].title, ok: false, reason: "status_blocked" },
      ]);
      expect(native.sends).toEqual([
        { pane_id: "w1:p1", text: "/model org/chat(anthropic)", keys: ["Enter"] },
        { pane_id: "w1:p1", text: "/effort high", keys: ["Enter"] },
      ]);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"], model: "bad model" })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"], effort: "ultra" })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"] })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: [] , model: "x" })).status).toBe(400);
    } finally { await env.cleanup(); await native.close(); }
  }, 30000);
}