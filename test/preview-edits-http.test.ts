import { expect, test } from "bun:test";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editEnvironment } from "./fixtures/edit-environment.ts";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] as const : ["bun"] as const) {
  test(`${backend}: preview edits authenticate, validate paths, list exact targets and deliver once`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24851 : 24852);
    try {
      expect((await fetch(`${env.base}/api/preview-edits/agents?path=${encodeURIComponent(env.path)}`)).status).toBe(401);
      expect((await fetch(`${env.base}/api/preview-edits/send`, { method: "POST", headers: { Origin: env.base, "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
      await env.login(true);
      const agents = await env.list(); expect(agents).toHaveLength(1);
      const agent = agents[0]!;
      expect(agent).toMatchObject({ targetId: "local", paneId: "w1:p1", workspace: "Documents", title: "local editor", cwd: env.directory, status: "idle" });
      const body = env.submission(agent, "1");
      expect((await env.api("/api/preview-edits/send", "POST", body, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await env.api("/api/preview-edits/send", "POST", body, { Origin: "null" })).status).toBe(403);
      expect((await env.api("/api/preview-edits/send", "POST", body, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
      expect((await env.api("/api/preview-edits/agents?path=relative.md")).status).toBe(400);
      expect((await env.api(`/api/preview-edits/agents?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(403);
      await symlink("/etc/hosts", join(env.directory, "escape.md"));
      expect((await env.api(`/api/preview-edits/agents?path=${encodeURIComponent(join(env.directory, "escape.md"))}`)).status).toBe(403);
      await writeFile(join(env.state, "private.md"), "secret");
      expect((await env.api(`/api/preview-edits/agents?path=${encodeURIComponent(join(env.state, "private.md"))}`)).status).toBe(403);
      for (const patch of [{ requestId: "../x" }, { paneId: "p; touch x" }, { session: "wrong" }, { edits: [] }, { kind: "html" }, { capturedAt: "not-a-date" }, { capturedAt: "notT-a-date" }, { edits: [{ ...body.edits[0], instruction: "unsafe\u001b[31m" }] }, { edits: Array(31).fill(body.edits[0]) }]) expect((await env.api("/api/preview-edits/send", "POST", { ...body, ...patch })).status).toBe(400);
      const oversized = await env.api("/api/preview-edits/send", "POST", { ...body, padding: "x".repeat(256 * 1024) });
      expect([400, 413]).toContain(oversized.status);
      expect((await env.api("/api/preview-edits/agents?path=" + encodeURIComponent(env.path), "GET", undefined, { Host: "evil.example" })).status).toBe(403);
      expect(await env.received()).toHaveLength(0);
      const delivered = await env.api("/api/preview-edits/send", "POST", body);
      expect(delivered.status).toBe(200); expect(await delivered.json()).toEqual({ state: "sent" });
      const received = await env.received(); expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ paneId: "w1:p1", remote: false, receiptWasPending: true });
      expect(received[0].text).toContain("先读取当前文件");
      expect(received[0].text).toContain("保护已有修改");
      const changes = JSON.parse(received[0].text.slice(received[0].text.indexOf('{\n  "changes"'))).changes;
      expect(changes[0]).toMatchObject({ original: body.edits[0]!.anchor.text, userRequest: body.edits[0]!.instruction, suggestedReplacement: body.edits[0]!.replacement });
      expect((await stat(join(env.state, "preview-edit-receipts", `${body.requestId}.json`))).mode & 0o777).toBe(0o600);
      expect(await (await env.api("/api/preview-edits/send", "POST", body)).json()).toEqual({ state: "sent" });
      expect((await env.api("/api/preview-edits/send", "POST", { ...body, capturedAt: "2026-10-26T05:00:00.000Z" })).status).toBe(409);
      expect(await env.received()).toHaveLength(1);
      expect(await readFile(env.path, "utf8")).toBe(env.markdown);
      await env.stop(); await env.start(); await env.login();
      expect(await (await env.api("/api/preview-edits/send", "POST", body)).json()).toEqual({ state: "sent" });
      expect(await env.received()).toHaveLength(1);
      const target = await (await env.api("/api/herdr/targets", "POST", { name: "remote docs", remote: "editor@fixture.test", session: "review" })).json();
      const listed = await env.list(); const remote = listed.find(a => a.targetId === target.id)!;
      expect(remote).toMatchObject({ title: "remote editor", connection: "remote docs", workspace: "Documents" });
      expect(remote.session).not.toBe(agent.session);
      const remoteBody = env.submission(remote, "2");
      expect(await (await env.api("/api/preview-edits/send", "POST", remoteBody)).json()).toEqual({ state: "sent" });
      const all = await env.received(); expect(all).toHaveLength(2); expect(all[1].remote).toBe(true);
      const remoteChanges = JSON.parse(all[1].text.slice(all[1].text.indexOf('{\n  "changes"'))).changes;
      expect(remoteChanges[0].suggestedReplacement).toBe(body.edits[0]!.replacement);
      expect(await Bun.file("/tmp/shelt-edit-injection").exists()).toBe(false);
      expect(await readFile(env.path, "utf8")).toBe(env.markdown);
    } finally { await env.cleanup(); }
  }, 45000);

  test(`${backend}: opening a terminal preview freezes the local or remote source agent without delivering`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24857 : 24858);
    const sourceOf = (response: Response) => {
      expect(response.status).toBe(302);
      const url = new URL(response.headers.get("location")!, env.base);
      expect(url.pathname).toBe("/preview"); expect(url.searchParams.get("path")).toBe(env.path);
      return JSON.parse(url.searchParams.get("source") || "null");
    };
    const openPreview = (path = env.path) => fetch(`${env.base}/api/preview-edits/open?path=${encodeURIComponent(path)}`, { headers: { cookie: env.cookie(), Origin: env.base }, redirect: "manual" });
    try {
      expect((await openPreview()).status).toBe(401);
      await env.login(true);
      const local = (await env.list())[0]!;
      const source = sourceOf(await openPreview());
      expect(source).toEqual({ targetId: "local", paneId: local.paneId, session: local.session });
      expect(sourceOf(await openPreview("document.md"))).toEqual(source);
      await env.setControl({ focusedPane: "another-pane" });
      expect(sourceOf(await openPreview())).toBeNull();
      expect(source.session).toBe(local.session);
      await env.setControl({ status: "working" });
      expect(sourceOf(await openPreview())).toEqual(source);
      const target = await (await env.api("/api/herdr/targets", "POST", { name: "Remote docs", remote: "editor@fixture.test", session: "review" })).json();
      expect((await env.api("/api/herdr/active", "POST", { id: target.id })).ok).toBe(true);
      const remote = (await env.list()).find(a => a.targetId === target.id)!;
      expect(sourceOf(await openPreview())).toEqual({ targetId: target.id, paneId: remote.paneId, session: remote.session });
      expect(remote.workspace).toBe("Documents");
      expect(remote.session).not.toBe(local.session);
      await env.setControl({ unavailable: true });
      expect(sourceOf(await openPreview())).toBeNull();
      expect((await openPreview("document.md")).status).toBe(503);
      expect((await openPreview("/etc/hosts")).status).toBe(403);
      expect(await env.received()).toHaveLength(0);
    } finally { await env.cleanup(); }
  }, 45000);

  test(`${backend}: preview edits preserve busy, changed, failed and uncertain deliveries without replay`, async () => {
    const env = await editEnvironment(backend, backend === "bun" ? 24853 : 24854);
    try {
      await env.login(true); const agent = (await env.list())[0]!;
      await env.setControl({ status: "working" });
      expect(await (await env.api("/api/preview-edits/send", "POST", env.submission(agent, "3"))).json()).toEqual({ error: "agent_busy" });
      await env.setControl({ terminal: "terminal-2" });
      expect(await (await env.api("/api/preview-edits/send", "POST", env.submission(agent, "4"))).json()).toEqual({ error: "agent_changed" });
      expect(await env.received()).toHaveLength(0);
      await env.setControl({ unavailable: true });
      expect(await env.list()).toEqual([]);
      expect(await (await env.api("/api/preview-edits/send", "POST", env.submission(agent, "5"))).json()).toEqual({ error: "unavailable" });
      await env.setControl({ reject: true });
      const rejected = env.submission(agent, "6");
      expect(await (await env.api("/api/preview-edits/send", "POST", rejected)).json()).toEqual({ error: "agent_busy" });
      expect(await (await env.api("/api/preview-edits/send", "POST", rejected)).json()).toEqual({ error: "agent_busy" });
      expect(await env.received()).toHaveLength(1);
      await env.setControl({ disconnect: true });
      const uncertain = env.submission(agent, "7");
      expect(await (await env.api("/api/preview-edits/send", "POST", uncertain)).json()).toEqual({ state: "uncertain" });
      expect(await (await env.api("/api/preview-edits/send", "POST", uncertain)).json()).toEqual({ state: "uncertain" });
      expect(await env.received()).toHaveLength(2);
      await env.setControl({ delay: 250 });
      const concurrent = env.submission(agent, "8");
      const results = await Promise.all([env.api("/api/preview-edits/send", "POST", concurrent), env.api("/api/preview-edits/send", "POST", concurrent)]);
      const states = await Promise.all(results.map(r => r.json()));
      expect(states.some(s => s.state === "sent")).toBe(true);
      expect(await env.received()).toHaveLength(3);
      expect(await (await env.api("/api/preview-edits/send", "POST", concurrent)).json()).toEqual({ state: "sent" });
      expect(await env.received()).toHaveLength(3);
      const receiptPath = join(env.state, "preview-edit-receipts", `${concurrent.requestId}.json`);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      await writeFile(receiptPath, JSON.stringify({ ...receipt, state: "pending" }));
      await env.stop(); await env.start(); await env.login();
      expect(await (await env.api("/api/preview-edits/send", "POST", concurrent)).json()).toEqual({ state: "uncertain" });
      expect(await env.received()).toHaveLength(3);
      expect(await readFile(env.path, "utf8")).toBe(env.markdown);
    } finally { await env.cleanup(); }
  }, 45000);
}
