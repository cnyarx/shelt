import { TodoStore } from "./todo-store.ts";
import { TodoError, todoFail, todoPrompt, todoView, validId } from "./todos.ts";
import { allowedOrigin } from "./security.ts";
import type { PreviewEditService } from "./preview-edit-service.ts";
import type { TargetStore } from "./targets.ts";

export class TodoHttp {
  private readonly prompts = new Map<string, { prompt: string; expiresAt: number }>();
  constructor(readonly store: TodoStore, private agents: PreviewEditService, private targets: TargetStore, private authenticated: (req: Request) => boolean, private publicHosts: Set<string>, private origins: string[]) {}
  async handle(req: Request): Promise<Response> {
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    try {
      const url = new URL(req.url), path = url.pathname.slice("/api/todos".length).split("/").filter(Boolean);
      const authorization = req.headers.get("authorization");
      const bearer = authorization === null ? null : authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const cookie = this.authenticated(req);
      const management = ["grants", "prompt", "agents", "send"].includes(path[0] || "");
      if (management && (bearer !== null || !cookie)) todoFail(bearer !== null ? 403 : 401, "browser_only");
      if (req.method !== "GET" && (bearer === null || req.headers.has("origin")) && !allowedOrigin(req.headers.get("origin"), url.host, this.origins)) todoFail(403, "forbidden_origin");
      const actor = this.store.actor(await this.store.read(), bearer, cookie);
      if (path[0] === "events" && path.length === 1 && req.method === "GET") {
        const encoder = new TextEncoder(); let timer: ReturnType<typeof setInterval> | undefined, running = false, closed = false, revision = -1, ticks = 0;
        const stream = new ReadableStream<Uint8Array>({
          start: controller => {
            const stop = () => { if (closed) return; closed = true; clearInterval(timer); try { controller.close(); } catch {} };
            const tick = async () => {
              if (running || closed) return; running = true;
              try {
                const data = await this.store.read(), current = this.store.actor(data, bearer, this.authenticated(req));
                if (data.revision !== revision) { controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(todoView(data, current.scope))}\n\n`)); revision = data.revision; }
                else if (++ticks % 20 === 0) controller.enqueue(encoder.encode(": keep-alive\n\n"));
              } catch { stop(); } finally { running = false; }
            };
            timer = setInterval(() => { void tick(); }, 1000); void tick();
            req.signal.addEventListener("abort", stop, { once: true });
          }, cancel() { closed = true; clearInterval(timer); },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
      }
      let body: Record<string, any> = {};
      if (!["GET", "HEAD"].includes(req.method)) {
        if (Number(req.headers.get("content-length")) > 128 * 1024) todoFail(413, "too_large");
        const reader = req.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) { await reader.cancel(); todoFail(413, "too_large"); } chunks.push(value); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { todoFail(400, "invalid_body"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) todoFail(400, "invalid_body");
      }
      if (path[0] === "agents" && path.length === 1 && req.method === "GET") {
        const { active, targets } = this.targets.list();
        const [agents, source] = await Promise.all([this.agents.list(targets), this.agents.source(targets.find(t => t.id === active) || null)]);
        return reply({ agents, source: source.agent });
      }
      if (path[0] === "grants") {
        if (path.length === 1 && req.method === "GET") return reply(await this.store.grants(cookie));
        if (path.length === 1 && req.method === "POST") {
          if (!(body.projectId === null || validId(body.projectId))) todoFail(400, "invalid_scope");
          return reply(await this.store.grant(body.projectId, body.ttlSeconds, cookie));
        }
        if (path.length === 2 && req.method === "DELETE") { this.prompts.delete(path[1]!); return reply(await this.store.revoke(path[1]!, cookie)); }
      }
      if (path[0] === "prompt" && path.length === 1 && req.method === "POST") {
        if (!(body.projectId === null || validId(body.projectId)) || typeof body.baseUrl !== "string") todoFail(400, "invalid_scope");
        let base: URL;
        try { base = new URL(body.baseUrl); } catch { todoFail(400, "invalid_base_url"); }
        if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash || !this.publicHosts.has(base.host.toLowerCase())) todoFail(400, "invalid_base_url");
        const grant = await this.store.grant(body.projectId, body.ttlSeconds, cookie);
        const prompt = todoPrompt(base.origin, grant.token, grant.projectId, grant.expiresAt, todoView(await this.store.read(), grant.projectId));
        if (Buffer.byteLength(prompt) > 60 * 1024) { await this.store.revoke(grant.id, cookie); todoFail(413, "too_large"); }
        for (const [id, stored] of this.prompts) if (stored.expiresAt <= Date.now()) this.prompts.delete(id);
        this.prompts.set(grant.id, { prompt, expiresAt: grant.expiresAt });
        return reply({ grantId: grant.id, projectId: grant.projectId, expiresAt: grant.expiresAt, prompt });
      }
      if (path[0] === "send" && path.length === 1 && req.method === "POST") {
        if (!validId(body.requestId) || !validId(body.grantId) || typeof body.paneId !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(body.paneId) || typeof body.session !== "string" || !/^[a-f0-9]{64}$/.test(body.session)) todoFail(400, "invalid_request");
        const data = await this.store.read(), grant = data.tokens.find(g => g.id === body.grantId && !g.revoked && g.expiresAt > Date.now());
        const stored = this.prompts.get(body.grantId);
        if (!grant || !stored || stored.expiresAt <= Date.now()) todoFail(410, "regenerate_prompt");
        const target = this.targets.list().targets.find(t => t.id === body.targetId);
        if (body.targetId !== "local" && !target) todoFail(404, "unavailable");
        const result = await this.agents.sendText({ requestId: body.requestId, targetId: body.targetId, paneId: body.paneId, session: body.session, grantId: body.grantId }, target || null, stored.prompt);
        return reply(result, result.error ? 409 : 200);
      }
      if (req.method === "GET") return reply(await this.store.query(path, bearer, cookie));
      if (["POST", "PATCH", "DELETE"].includes(req.method) && ["projects", "items"].includes(path[0] || "") && path.length <= 3) return reply(await this.store.mutate(req.method, path, body, bearer, cookie));
      void actor;
      todoFail(404, "not_found");
    } catch (error) { return error instanceof TodoError ? reply({ error: error.code }, error.status) : reply({ error: "todo_storage_unavailable" }, 503); }
  }
}
