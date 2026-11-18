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
  expect(await modelOptions({ HOME: home } as NodeJS.ProcessEnv)).toEqual({ models: ["prov-a", "prov-b", "default-c"], defaultModel: "default-c" });
  expect(await modelOptions({ HOME: join(home, "missing") } as NodeJS.ProcessEnv)).toEqual({ models: [], defaultModel: "" });
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
      native.setScreen("w1:p1", EMPTY_BOX);
      native.setScreen("w1:p2", DRAFT_BOX);
      expect((await fetch(`${env.base}/api/agent-config/options`)).status).toBe(401);
      const options = await (await env.api("/api/agent-config/options")).json();
      expect(options.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(options.agents.map((a: any) => [a.paneId, a.status, a.input])).toEqual([
        ["w1:p1", "idle", ""],
        ["w1:p2", "blocked", "hello"],
      ]);
      const applied = await (await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1", "w1:p2"], model: "prov-a", effort: "high" })).json();
      expect(applied.results).toEqual([
        { paneId: "w1:p1", title: options.agents[0].title, ok: true, reason: "sent" },
        { paneId: "w1:p2", title: options.agents[1].title, ok: false, reason: "status_blocked" },
      ]);
      expect(native.sends).toEqual([
        { pane_id: "w1:p1", text: "/model prov-a", keys: ["Enter"] },
        { pane_id: "w1:p1", text: "/effort high", keys: ["Enter"] },
      ]);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"], model: "bad model" })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"], effort: "ultra" })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: ["w1:p1"] })).status).toBe(400);
      expect((await env.api("/api/agent-config/apply", "POST", { panes: [] , model: "x" })).status).toBe(400);
    } finally { await env.cleanup(); await native.close(); }
  }, 30000);
}