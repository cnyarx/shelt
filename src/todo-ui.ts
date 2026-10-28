import { getLanguage, onLanguageChange, t } from "./i18n.ts";
import { agentReady, type EditAgent } from "./preview-edits.ts";
import { sameAgent, type PreviewSource } from "./preview-source.ts";
import { descendants, TODO_STATES, todoSummary, type TodoItem, type TodoProject, type TodoView } from "./todos.ts";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const requestId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, "0")).join("");
const statusName = (status: string) => ({ todo: t("todoPending"), doing: t("todoDoing"), blocked: t("todoBlocked"), done: t("todoDone"), canceled: t("todoCanceled"), empty: t("todoEmpty") })[status] || status;
const statusIcon = (status: string) => ({ todo: "○", doing: "◉", blocked: "⊘", done: "✓", canceled: "−", empty: "□" })[status] || "□";
const ordered = <T extends { order: number; id: string }>(nodes: T[]) => [...nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

export class TodoController {
  private readonly toggle = element<HTMLButtonElement>("todo-toggle");
  private readonly panel = element<HTMLElement>("todo-panel");
  private readonly project = element<HTMLSelectElement>("todo-project");
  private readonly tree = element<HTMLElement>("todo-tree");
  private readonly form = element<HTMLFormElement>("todo-form");
  private readonly title = element<HTMLInputElement>("todo-title");
  private readonly description = element<HTMLTextAreaElement>("todo-description");
  private readonly parent = element<HTMLSelectElement>("todo-parent");
  private readonly editProject = element<HTMLSelectElement>("todo-edit-project");
  private readonly state = element<HTMLSelectElement>("todo-state");
  private readonly order = element<HTMLInputElement>("todo-order");
  private readonly prompt = element<HTMLTextAreaElement>("todo-prompt-text");
  private readonly agent = element<HTMLSelectElement>("todo-agent");
  private data: TodoView = { revision: 0, projects: [], items: [] };
  private events: EventSource | null = null;
  private online = false;
  private visible = false;
  private editing: { collection: "projects" | "items"; id?: string; kind?: "folder" | "task"; revision: number; requestId: string } | null = null;
  private folded = new Set<string>();
  private agents: EditAgent[] = [];
  private chosen: PreviewSource | null = null;
  private manualAgent = false;
  private generated: { grantId: string; projectId: string | null; expiresAt: number; prompt: string } | null = null;
  private sendId = requestId();
  private sending = false;
  private delivered = false;
  private pendingSend: { requestId: string; grantId: string; targetId: string; paneId: string; session: string } | null = null;

  constructor() {
    this.toggle.addEventListener("click", () => this.open(!!this.panel.hidden));
    element("todo-close").addEventListener("click", () => this.open(false));
    this.project.addEventListener("change", () => { this.form.hidden = true; this.editing = null; this.clearPrompt(); this.render(); });
    element("todo-hide-done").addEventListener("change", () => this.renderTree());
    element("todo-new-project").addEventListener("click", () => this.edit("projects"));
    element("todo-edit-project-button").addEventListener("click", () => { const selected = this.data.projects.find(p => p.id === this.project.value); if (selected) this.edit("projects", selected); });
    element("todo-new-task").addEventListener("click", () => this.edit("items", undefined, "task"));
    element("todo-new-folder").addEventListener("click", () => this.edit("items", undefined, "folder"));
    element("todo-cancel").addEventListener("click", () => { this.editing = null; this.form.hidden = true; });
    this.editProject.addEventListener("change", () => this.renderParents());
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.save().catch(e => this.error(e)); });
    element("todo-delete").addEventListener("click", () => { void this.remove().catch(e => this.error(e)); });
    element("todo-prompt-toggle").addEventListener("click", () => { const section = element("todo-prompt-panel"); section.hidden = !section.hidden; if (!section.hidden) { element<HTMLInputElement>("todo-base-url").value ||= location.origin; void this.refreshAgents(); void this.renderGrants(); } });
    element("todo-generate").addEventListener("click", () => { void this.generate().catch(e => this.error(e)); });
    element("todo-copy").addEventListener("click", () => { void this.copy(); });
    element("todo-send").addEventListener("click", () => { void this.send().catch(e => this.error(e)); });
    element("todo-refresh-agents").addEventListener("click", () => { void this.refreshAgents(); });
    this.agent.addEventListener("change", () => { this.manualAgent = true; this.chosen = this.agents.find(a => this.identity(a) === this.agent.value) || null; this.renderSend(); });
    window.addEventListener("keydown", event => { if (event.key === "Escape") this.open(false); });
    document.addEventListener("pointerdown", event => { const target = event.target as Node; if (!this.panel.hidden && !this.panel.contains(target) && !this.toggle.contains(target)) this.open(false); });
    onLanguageChange(() => { this.render(); this.renderStates(); });
    this.renderStates(); this.render();
  }
  setVisible(value: boolean): void {
    this.visible = value; this.toggle.hidden = !value;
    if (!value) { this.open(false); this.events?.close(); this.events = null; this.clearPrompt(); return; }
    if (this.events) return;
    this.events = new EventSource("/api/todos/events", { withCredentials: true });
    this.events.addEventListener("snapshot", event => {
      this.data = JSON.parse((event as MessageEvent).data) as TodoView;
      this.online = true; this.render();
    });
    this.events.onopen = () => { this.online = true; this.connection(); };
    this.events.onerror = () => { this.online = false; this.connection(); };
    void this.refresh().catch(e => this.error(e));
  }
  private open(open: boolean): void {
    this.panel.hidden = !open || !this.visible; this.toggle.setAttribute("aria-expanded", String(!this.panel.hidden));
    if (open) {
      for (const id of ["settings-toggle", "terminal-tts-toggle"]) { const other = element<HTMLButtonElement>(id); if (other.getAttribute("aria-expanded") === "true") other.click(); }
      void this.refresh().catch(e => this.error(e));
    }
  }
  private async api(path = "", method = "GET", body?: unknown): Promise<any> {
    const response = await fetch("/api/todos" + path, { method, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "network_error");
    return result;
  }
  private async refresh(): Promise<void> { this.data = await this.api(); this.render(); }
  private connection(): void { element("todo-connection").textContent = t(this.online ? "todoLive" : "todoOffline"); }
  private error(error: unknown): void {
    const code = error instanceof Error ? error.message : "network_error";
    const messages: Record<string, string> = { revision_conflict: t("todoConflict"), write_busy: t("todoConflict"), scope_forbidden: t("forbidden"), authentication_required: t("loginRequired"), regenerate_prompt: t("todoRegenerate"), invalid_parent: t("todoInvalidParent"), invalid_base_url: t("todoInvalidAddress"), invalid_scope: t("todoScopeRequired"), confirmation_required: t("todoDeleteConfirm"), agent_busy: t("editBusy"), agent_changed: t("editChangedAgent") };
    element("todo-status").textContent = messages[code] || t("todoError");
    if (code === "revision_conflict" || code === "write_busy") void this.refresh().then(() => { if (this.editing) { this.editing.revision = this.data.revision; this.editing.requestId = requestId(); } });
  }
  private renderStates(): void {
    const previous = this.state.value;
    this.state.replaceChildren(...TODO_STATES.map(s => new Option(`${statusIcon(s)} ${statusName(s)}`, s)));
    this.state.value = previous || "todo";
  }
  private render(): void {
    const selected = this.project.value;
    this.project.replaceChildren(new Option(t("todoAllProjects"), ""), ...ordered(this.data.projects).map(p => new Option(p.title, p.id)));
    this.project.value = this.data.projects.some(p => p.id === selected) ? selected : "";
    const summary = todoSummary(this.data.items); element("todo-count").textContent = String(summary.remaining);
    this.toggle.title = `${t("todoList")} · ${summary.remaining}`;
    element<HTMLButtonElement>("todo-edit-project-button").disabled = !this.project.value;
    element<HTMLButtonElement>("todo-new-task").disabled = !this.project.value;
    element<HTMLButtonElement>("todo-new-folder").disabled = !this.project.value;
    this.connection(); this.renderTree(); this.renderSend();
  }
  private renderTree(): void {
    this.tree.replaceChildren();
    const hide = element<HTMLInputElement>("todo-hide-done").checked;
    const projects = ordered(this.data.projects.filter(p => !this.project.value || p.id === this.project.value));
    if (!projects.length) { const empty = document.createElement("p"); empty.textContent = t("todoCreateFirst"); this.tree.append(empty); }
    const button = (text: string, action: () => void, label: string) => { const el = document.createElement("button"); el.type = "button"; el.textContent = text; el.title = label; el.setAttribute("aria-label", label); el.addEventListener("click", action); return el; };
    const draw = (nodes: TodoItem[], project: TodoProject, parent: string | null, depth: number, mount: HTMLElement) => {
      for (const item of ordered(nodes.filter(i => i.parentId === parent && (!hide || i.kind === "folder" || !["done", "canceled"].includes(i.status!))))) {
        const row = document.createElement("div"); row.className = "todo-row"; row.style.setProperty("--depth", String(depth)); row.dataset.itemId = item.id;
        if (item.kind === "folder") {
          const summary = todoSummary(nodes, item.id);
          const fold = button(this.folded.has(item.id) ? "▸" : "▾", () => { this.folded.has(item.id) ? this.folded.delete(item.id) : this.folded.add(item.id); this.renderTree(); }, t("todoFold")); fold.setAttribute("aria-expanded", String(!this.folded.has(item.id))); row.append(fold);
          const label = document.createElement("span"); label.className = "todo-title"; label.textContent = item.title; row.append(label);
          const progress = document.createElement("span"); progress.className = "todo-progress"; progress.textContent = `${summary.done}/${summary.active}`; progress.title = statusName(summary.status); row.append(progress);
        } else {
          const state = document.createElement("select"); state.className = `todo-row-state status-${item.status}`; state.setAttribute("aria-label", `${item.title} · ${t("todoState")}`);
          state.replaceChildren(...TODO_STATES.map(s => new Option(`${statusIcon(s)} ${statusName(s)}`, s))); state.value = item.status!;
          state.addEventListener("change", () => { state.disabled = true; void this.api(`/items/${item.id}`, "PATCH", { revision: this.data.revision, status: state.value }).then(result => { this.data = result.snapshot; this.render(); }).catch(e => { this.render(); this.error(e); }); });
          const label = document.createElement("span"); label.className = "todo-title"; label.textContent = item.title; label.title = item.description; row.append(state, label);
        }
        row.append(button("⋯", () => this.edit("items", item), t("edit"))); mount.append(row);
        if (item.kind === "folder" && !this.folded.has(item.id)) draw(nodes, project, item.id, depth + 1, mount);
      }
    };
    for (const project of projects) {
      const nodes = this.data.items.filter(i => i.projectId === project.id), summary = todoSummary(nodes), section = document.createElement("section"), header = document.createElement("div"); header.className = "todo-project-heading";
      const fold = button(this.folded.has(project.id) ? "▸" : "▾", () => { this.folded.has(project.id) ? this.folded.delete(project.id) : this.folded.add(project.id); this.renderTree(); }, t("todoFold")); fold.setAttribute("aria-expanded", String(!this.folded.has(project.id)));
      const title = document.createElement("strong"); title.textContent = project.title;
      const progress = document.createElement("span"); progress.className = "todo-progress"; progress.textContent = `${summary.done}/${summary.active}`; progress.title = `${statusName(summary.status)} · ${t("todoCanceled")} ${summary.canceled}`;
      header.append(fold, title, progress, button("⋯", () => this.edit("projects", project), t("edit"))); section.append(header);
      if (!this.folded.has(project.id)) draw(nodes, project, null, 0, section);
      this.tree.append(section);
    }
  }
  private edit(collection: "projects" | "items", node?: TodoProject | TodoItem, kind: "folder" | "task" = "task"): void {
    this.editing = { collection, id: node?.id, kind: collection === "items" ? (node as TodoItem | undefined)?.kind || kind : undefined, revision: this.data.revision, requestId: requestId() };
    this.title.value = node?.title || ""; this.description.value = node?.description || ""; this.order.value = String(node?.order ?? 0);
    this.editProject.replaceChildren(...ordered(this.data.projects).map(p => new Option(p.title, p.id)));
    this.editProject.value = (node as TodoItem | undefined)?.projectId || this.project.value;
    element("todo-item-fields").hidden = collection === "projects";
    element("todo-state-label").hidden = collection === "projects" || this.editing.kind === "folder";
    this.state.value = (node as TodoItem | undefined)?.status || "todo";
    element<HTMLButtonElement>("todo-delete").hidden = !node;
    this.renderParents(); if (collection === "items") this.parent.value = (node as TodoItem | undefined)?.parentId || "";
    this.form.hidden = false; this.title.focus();
  }
  private renderParents(): void {
    const id = this.editing?.id;
    const excluded = id ? [id, ...descendants(this.data.items, id)] : [];
    this.parent.replaceChildren(new Option(t("todoRoot"), ""), ...ordered(this.data.items.filter(i => i.projectId === this.editProject.value && i.kind === "folder" && !excluded.includes(i.id))).map(i => new Option(i.title, i.id)));
  }
  private async save(): Promise<void> {
    if (!this.editing) return;
    const edit = this.editing, button = element<HTMLButtonElement>("todo-save"); button.disabled = true;
    try {
      const body: Record<string, unknown> = { revision: edit.revision, title: this.title.value, description: this.description.value, order: Number(this.order.value) };
      if (!edit.id) body.requestId = edit.requestId;
      if (edit.collection === "items") { body.parentId = this.parent.value || null; if (!edit.id) body.kind = edit.kind; else body.projectId = this.editProject.value; if (edit.kind === "task") body.status = this.state.value; }
      const path = edit.id ? `/${edit.collection}/${edit.id}` : edit.collection === "projects" ? "/projects" : `/projects/${this.editProject.value}/items`;
      const result = await this.api(path, edit.id ? "PATCH" : "POST", body);
      this.data = result.snapshot; if (edit.collection === "projects" && !edit.id) { this.render(); this.project.value = result.result.id; }
      this.editing = null; this.form.hidden = true; this.render(); element("todo-status").textContent = t("todoSaved");
    } finally { button.disabled = false; }
  }
  private async remove(): Promise<void> {
    const edit = this.editing; if (!edit?.id) return;
    const count = edit.collection === "projects" ? this.data.items.filter(i => i.projectId === edit.id).length : descendants(this.data.items, edit.id).length;
    if (!confirm(`${t("todoDeleteConfirm")} ${count ? t("todoDeleteChildren", { count }) : ""}`)) return;
    const result = await this.api(`/${edit.collection}/${edit.id}`, "DELETE", { revision: edit.revision, recursive: count > 0 });
    this.data = result.snapshot; this.editing = null; this.form.hidden = true; this.clearPrompt(); this.render();
  }
  private identity(agent: PreviewSource): string { return `${agent.targetId}:${agent.paneId}:${agent.session}`; }
  private async refreshAgents(): Promise<void> {
    try {
      const result = await this.api("/agents") as { agents: EditAgent[]; source: EditAgent | null };
      this.agents = result.agents;
      if (!this.manualAgent) this.chosen = result.source;
      this.agent.replaceChildren(new Option(t("editChooseAgent"), ""), ...this.agents.map(a => new Option(`${a.connection} / ${a.workspace} / ${a.title} · ${a.status}`, this.identity(a))));
      const selected = this.chosen && this.agents.find(a => sameAgent(a, this.chosen!)); this.agent.value = selected ? this.identity(selected) : "";
      this.renderSend();
    } catch { this.agents = []; this.agent.replaceChildren(new Option(t("editNoAgents"), "")); this.renderSend(); }
  }
  private clearPrompt(): void { this.generated = null; this.prompt.value = ""; this.sendId = requestId(); this.pendingSend = null; this.delivered = false; this.renderSend(); }
  private async generate(): Promise<void> {
    const all = element<HTMLInputElement>("todo-all-scope").checked;
    if (!this.project.value && !all) throw new Error("invalid_scope");
    this.clearPrompt();
    this.generated = await this.api("/prompt", "POST", { projectId: all ? null : this.project.value, ttlSeconds: Number(element<HTMLSelectElement>("todo-ttl").value), baseUrl: element<HTMLInputElement>("todo-base-url").value });
    this.prompt.value = this.generated!.prompt; this.renderSend(); void this.renderGrants();
    element("todo-status").textContent = `${t("todoExpires")} ${new Date(this.generated!.expiresAt).toLocaleString(getLanguage())}`;
  }
  private renderSend(): void {
    const agent = this.agents.find(a => this.identity(a) === this.agent.value);
    const expired = !this.generated || this.generated.expiresAt <= Date.now();
    element<HTMLButtonElement>("todo-send").disabled = expired || this.delivered || this.sending || (!this.pendingSend && (!agent || !agentReady(agent.status)));
    this.agent.disabled = this.sending || !!this.pendingSend;
    element<HTMLButtonElement>("todo-generate").disabled = this.sending;
    element<HTMLButtonElement>("todo-copy").disabled = expired;
  }
  private async copy(): Promise<void> { try { await navigator.clipboard.writeText(this.prompt.value); element("todo-status").textContent = t("editCopied"); } catch { this.prompt.focus(); this.prompt.select(); element("todo-status").textContent = t("editCopyManual"); } }
  private async send(): Promise<void> {
    if (!this.generated || this.generated.expiresAt <= Date.now() || this.sending || this.delivered) return;
    if (!this.pendingSend) {
      const agent = this.agents.find(a => this.identity(a) === this.agent.value);
      if (!agent || !agentReady(agent.status)) return;
      this.pendingSend = { requestId: this.sendId, grantId: this.generated.grantId, targetId: agent.targetId, paneId: agent.paneId, session: agent.session };
    }
    this.sending = true; this.renderSend();
    try {
      const result = await this.api("/send", "POST", this.pendingSend);
      if (result.state === "sent") { this.delivered = true; this.pendingSend = null; element("todo-status").textContent = t("todoSent"); }
      else element("todo-status").textContent = t("editUncertain");
    } catch (error) {
      const code = error instanceof Error ? error.message : "network_error";
      if (["agent_busy", "agent_changed", "unavailable", "regenerate_prompt", "invalid_request"].includes(code)) { this.pendingSend = null; this.sendId = requestId(); this.error(error); }
      else element("todo-status").textContent = t("editUncertain");
    } finally { this.sending = false; this.renderSend(); }
  }
  private async renderGrants(): Promise<void> {
    const mount = element("todo-grants");
    try {
      const result = await this.api("/grants"); mount.replaceChildren();
      for (const grant of result.grants.filter((g: any) => !g.revoked && g.expiresAt > Date.now())) {
        const row = document.createElement("div"); row.className = "todo-grant";
        const label = document.createElement("span"); label.textContent = `${this.data.projects.find(p => p.id === grant.projectId)?.title || t("todoAllProjects")} · ${new Date(grant.expiresAt).toLocaleTimeString(getLanguage())}`;
        const revoke = document.createElement("button"); revoke.type = "button"; revoke.textContent = t("todoRevoke");
        revoke.addEventListener("click", () => { void this.api(`/grants/${grant.id}`, "DELETE", {}).then(() => { if (this.generated?.grantId === grant.id) this.clearPrompt(); return this.renderGrants(); }).catch(e => this.error(e)); });
        row.append(label, revoke); mount.append(row);
      }
    } catch (e) { this.error(e); }
  }
}
