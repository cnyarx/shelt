import { onLanguageChange, t, type MessageKey } from "./i18n.ts";
import { agentReady, buildEditPrompt, sortEditAgents, validateEditDocument, type EditAgent, type EditAnchor, type EditDocument, type EditSubmission, type PreviewEdit } from "./preview-edits.ts";
import { anchorForBlocks, anchorForSelection, EDIT_BLOCKS } from "./preview-edit-selection.ts";
import { previewSource, sameAgent, type PreviewSource } from "./preview-source.ts";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, "0")).join("");
type Pending = { body: EditSubmission; state: "pending" | "sent" | "uncertain" };

export class PreviewEditController {
  private readonly toggle = element<HTMLButtonElement>("edit-toggle");
  private readonly panel = element<HTMLElement>("edit-panel");
  private readonly form = element<HTMLFormElement>("edit-form");
  private readonly instruction = element<HTMLTextAreaElement>("edit-instruction");
  private readonly replacement = element<HTMLTextAreaElement>("edit-replacement");
  private readonly useReplacement = element<HTMLInputElement>("edit-use-replacement");
  private readonly agentSelect = element<HTMLSelectElement>("edit-agent");
  private readonly prompt = element<HTMLTextAreaElement>("edit-prompt");
  private readonly sendButton = element<HTMLButtonElement>("edit-send");
  private readonly copyButton = element<HTMLButtonElement>("edit-copy");
  private readonly key: string;
  private doc: EditDocument;
  private current: PreviewEdit | null = null;
  private pending: Pending | null = null;
  private agents: EditAgent[] = [];
  private active = false;
  private sending = false;
  private root: ParentNode | null = null;
  private cleanup: (() => void) | undefined;
  private staticSwitch: (() => Promise<void>) | undefined;
  private hover: Element | null = null;
  private statusKey: MessageKey = "editHint";
  private chosen: PreviewSource | null;
  private manualChoice = false;
  private refreshGeneration = 0;

  constructor(path: string, kind: "markdown" | "html", private readonly source: PreviewSource | null = null) {
    this.chosen = source;
    this.key = `shelt-preview-edits:v1:${path}`;
    this.doc = { path, kind, capturedAt: new Date().toISOString(), edits: [] };
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.key) || "null");
      if (saved?.doc?.path === path && saved.doc.kind === kind && Array.isArray(saved.doc.edits) && (saved.doc.edits.length === 0 || validateEditDocument(saved.doc))) {
        this.doc = saved.doc;
        const savedSource = previewSource(saved.source);
        if ((!source && !savedSource) || (source && savedSource && sameAgent(source, savedSource))) {
          this.manualChoice = saved.manualChoice === true;
          if (this.manualChoice) this.chosen = previewSource(saved.chosen);
        }
        if (saved.current && validateEditDocument({ ...this.doc, edits: [{ ...saved.current, instruction: saved.current.instruction || "draft" }] })) this.current = saved.current;
        if (saved.pending && validateEditDocument(saved.pending.body) && saved.pending.body.path === path && /^[a-f0-9]{32}$/.test(saved.pending.body.requestId)) this.pending = saved.pending;
      }
    } catch {}
    this.toggle.hidden = false;
    this.toggle.addEventListener("click", () => this.setActive(!this.active));
    element("edit-close").addEventListener("click", () => this.setActive(false));
    element("edit-cancel").addEventListener("click", () => { this.current = null; this.persist(); this.render(); });
    this.form.addEventListener("submit", e => { e.preventDefault(); this.saveEdit(); });
    this.instruction.addEventListener("input", () => this.saveCurrent());
    this.replacement.addEventListener("input", () => this.saveCurrent());
    this.useReplacement.addEventListener("change", () => { this.replacement.hidden = !this.useReplacement.checked; this.saveCurrent(); });
    element("edit-static").addEventListener("click", () => { void this.staticSwitch?.().catch(() => this.status("switchPreviewError")); });
    element("edit-refresh-agents").addEventListener("click", () => { void this.refreshAgents(); });
    this.agentSelect.addEventListener("change", () => {
      const agent = this.selectedAgent();
      this.manualChoice = true;
      this.chosen = agent ? previewSource(agent) : null;
      this.persist();
      this.status(agent && !agentReady(agent.status) ? "editBusy" : "editHint");
      this.renderSend();
    });
    this.copyButton.addEventListener("click", () => { void this.copyPrompt(); });
    this.sendButton.addEventListener("click", () => { void this.send(); });
    window.addEventListener("shelt-selection-mode", event => { if ((event as CustomEvent).detail === "speech") this.setActive(false); });
    window.addEventListener("keydown", event => { if (event.key === "Escape") this.setActive(false); });
    onLanguageChange(() => this.render());
    this.render();
  }

  setDocument(root: ParentNode | null, switchToStatic?: () => Promise<void>): void {
    this.cleanup?.(); this.clearHover(); this.root = root; this.staticSwitch = switchToStatic;
    element("edit-static").hidden = !switchToStatic;
    if (!root) return;
    const owner = root.nodeType === 9 ? root as Document : (root as Element).ownerDocument;
    if (root.nodeType === 9 && !owner.getElementById("shelt-edit-style")) {
      const style = owner.createElement("style"); style.id = "shelt-edit-style";
      style.textContent = ".shelt-edit-hover{outline:2px dashed #0969da!important;outline-offset:3px;cursor:crosshair!important}";
      owner.head?.append(style);
    }
    const inRoot = (target: EventTarget | null) => {
      const el = target as Element | null;
      return el?.nodeType === 1 && root.contains(el) ? el : null;
    };
    const move = (e: Event) => {
      if (!this.active || this.locked()) return;
      const target = inRoot(e.target)?.closest(EDIT_BLOCKS) ?? null;
      if (target === this.hover) return;
      this.clearHover(); this.hover = target; this.hover?.classList.add("shelt-edit-hover");
    };
    let selectedOnRelease = false;
    const pick = (e: Event, selectionOnly: boolean) => {
      if (!this.active) return;
      const target = inRoot(e.target); if (!target) return;
      if (!selectionOnly) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (selectedOnRelease) return;
      }
      if (this.locked()) return;
      const selection = owner.getSelection();
      if (selectionOnly && (!selection || selection.isCollapsed)) return;
      const hasSelection = selection && !selection.isCollapsed;
      const selected = hasSelection ? anchorForSelection(root, selection) : null;
      if (hasSelection && !selected) { this.status("editLimit"); return; }
      const block = target.closest<HTMLElement>(EDIT_BLOCKS);
      if (!selected && !block) return;
      const anchor = selected ?? (block && root.contains(block) ? anchorForBlocks(root, [block]) : null);
      if (!anchor) { this.status("editLimit"); return; }
      if (this.current && (this.instruction.value.trim() || this.useReplacement.checked)) { this.status("editNeedsSave"); return; }
      if (selectionOnly) { selectedOnRelease = true; setTimeout(() => { selectedOnRelease = false; }, 0); }
      this.beginEdit(anchor); selection?.removeAllRanges();
    };
    const click = (event: Event) => pick(event, false);
    const release = (event: Event) => pick(event, true);
    owner.addEventListener("pointermove", move, true);
    owner.addEventListener("pointerup", release, true);
    owner.addEventListener("click", click, true);
    this.cleanup = () => { owner.removeEventListener("pointermove", move, true); owner.removeEventListener("pointerup", release, true); owner.removeEventListener("click", click, true); };
  }

  private locked(): boolean { return this.sending || !!this.pending && this.pending.state !== "sent"; }
  private clearHover(): void { this.hover?.classList.remove("shelt-edit-hover"); this.hover = null; }
  private setActive(active: boolean): void {
    this.active = active;
    this.panel.hidden = !active;
    this.toggle.setAttribute("aria-pressed", String(active));
    document.body.classList.toggle("editing-preview", active);
    if (active) {
      window.dispatchEvent(new CustomEvent("shelt-selection-mode", { detail: "edit" }));
      if (!this.agents.length) void this.refreshAgents();
    } else this.clearHover();
  }
  private status(key: MessageKey): void { this.statusKey = key; element("edit-status").textContent = t(key); }
  private persist(): void {
    try { sessionStorage.setItem(this.key, JSON.stringify({ doc: this.doc, current: this.current, pending: this.pending, source: this.source, chosen: this.chosen, manualChoice: this.manualChoice })); }
    catch { this.status("editStorage"); }
  }
  private saveCurrent(): void {
    if (!this.current || this.locked()) return;
    this.current.instruction = this.instruction.value;
    if (this.useReplacement.checked) this.current.replacement = this.replacement.value;
    else delete this.current.replacement;
    this.persist(); this.renderSend();
  }
  private beginEdit(anchor: EditAnchor, edit?: PreviewEdit): void {
    this.current = edit ? structuredClone(edit) : { id: newId(), anchor, instruction: "" };
    this.status("editHint");
    this.persist(); this.render(); this.instruction.focus();
  }
  private saveEdit(): void {
    if (!this.current || this.locked()) return;
    this.saveCurrent();
    const exists = this.doc.edits.some(e => e.id === this.current!.id);
    const next = exists ? this.doc.edits.map(e => e.id === this.current!.id ? this.current! : e) : [...this.doc.edits, this.current];
    if (!validateEditDocument({ ...this.doc, edits: next })) { this.status("editInvalid"); return; }
    this.doc.edits = next; this.current = null; this.pending = null;
    this.persist(); this.status("editHint"); this.render();
  }
  private render(): void {
    const current = this.current;
    this.form.hidden = !current;
    if (current) {
      const a = current.anchor;
      element("edit-location").textContent = [a.heading, a.lineStart ? t("editSourceLines", { start: a.lineStart, end: a.lineEnd! }) : a.locator].filter(Boolean).join(" · ");
      element("edit-original").textContent = a.text;
      this.instruction.value = current.instruction;
      this.useReplacement.checked = current.replacement !== undefined;
      this.replacement.value = current.replacement ?? ""; this.replacement.hidden = !this.useReplacement.checked;
      element("edit-save").textContent = t(this.doc.edits.some(e => e.id === current.id) ? "editSave" : "editAdd");
    }
    element("edit-count").textContent = t("editCount", { count: this.doc.edits.length });
    const list = element("edit-list"); list.replaceChildren();
    for (const edit of this.doc.edits) {
      const item = document.createElement("li"), text = document.createElement("p"), actions = document.createElement("div");
      text.textContent = `${edit.anchor.heading || edit.anchor.text.slice(0, 60)}：${edit.instruction}`;
      actions.className = "edit-actions";
      for (const [key, action] of [["edit", () => this.beginEdit(edit.anchor, edit)], ["remove", () => { this.doc.edits = this.doc.edits.filter(e => e.id !== edit.id); if (this.current?.id === edit.id) this.current = null; this.pending = null; this.persist(); this.render(); }]] as const) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = t(key); button.disabled = this.locked(); button.addEventListener("click", action); actions.append(button);
      }
      item.append(text, actions); list.append(item);
    }
    this.prompt.value = this.doc.edits.length ? buildEditPrompt(this.doc) : "";
    this.copyButton.disabled = !this.doc.edits.length;
    this.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button").forEach(el => el.disabled = this.locked());
    this.status(this.pending?.state === "sent" ? "editSent" : this.pending ? "editUncertain" : this.statusKey);
    this.renderSend();
  }
  private selectedAgent(): EditAgent | undefined { return this.agents.find((_, i) => String(i) === this.agentSelect.value); }
  private renderSend(): void {
    const agent = this.selectedAgent();
    this.sendButton.disabled = this.sending || !this.doc.edits.length || !!this.current || (!this.pending && (!agent || !agentReady(agent.status))) || this.pending?.state === "sent";
  }
  private async refreshAgents(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.agents = [];
    this.agentSelect.replaceChildren(new Option(t("editChooseAgent"), ""));
    this.agentSelect.value = "";
    this.renderSend();
    try {
      const response = await fetch(`/api/preview-edits/agents?path=${encodeURIComponent(this.doc.path)}`, { credentials: "same-origin", cache: "no-store" });
      if (generation !== this.refreshGeneration) return;
      if (!response.ok) { this.status(response.status === 401 ? "editUnauthorized" : "editNoAgents"); return; }
      const body = await response.json() as { agents: EditAgent[] };
      if (generation !== this.refreshGeneration) return;
      this.agents = sortEditAgents(body.agents, this.doc.path);
      this.agentSelect.replaceChildren(new Option(t("editChooseAgent"), ""));
      this.agents.forEach((a, i) => this.agentSelect.add(new Option(`${a.connection} / ${a.workspace} / ${a.title} · ${a.cwd} · ${a.status}`, String(i))));
      const index = this.chosen ? this.agents.findIndex(a => sameAgent(a, this.chosen!)) : -1;
      this.agentSelect.value = index < 0 ? "" : String(index);
      if (!this.agents.length) this.status("editNoAgents");
      else if (index >= 0 && !agentReady(this.agents[index]!.status)) this.status("editBusy");
      else if (index < 0 && this.chosen) this.status("editChangedAgent");
      else this.status("editHint");
      this.renderSend();
    } catch { if (generation === this.refreshGeneration) this.status("editNoAgents"); }
  }
  private async copyPrompt(): Promise<void> {
    try { await navigator.clipboard.writeText(this.prompt.value); this.status("editCopied"); }
    catch { this.prompt.focus(); this.prompt.select(); this.status("editCopyManual"); }
  }
  private async send(): Promise<void> {
    if (this.sending || !this.doc.edits.length || this.current || this.pending?.state === "sent") return;
    if (!this.pending) {
      const agent = this.selectedAgent();
      if (!agent) return;
      if (!agentReady(agent.status)) { this.status("editBusy"); return; }
      this.pending = { state: "pending", body: { ...structuredClone(this.doc), requestId: newId(), targetId: agent.targetId, paneId: agent.paneId, session: agent.session } };
    }
    this.persist(); this.sending = true; this.render(); this.status("editSending");
    try {
      const response = await fetch("/api/preview-edits/send", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.pending.body) });
      const body = await response.json() as { state?: string; error?: string };
      if (body.state === "sent") { this.pending.state = "sent"; this.status("editSent"); }
      else if (body.state === "pending" || body.state === "uncertain" || response.status >= 500) { this.pending.state = "uncertain"; this.status("editUncertain"); }
      else {
        this.pending = null;
        this.status(body.error === "agent_busy" ? "editBusy" : body.error === "agent_changed" ? "editChangedAgent" : response.status === 401 ? "editUnauthorized" : body.error === "unavailable" ? "editUnavailable" : "editFailed");
      }
    } catch { if (this.pending) this.pending.state = "uncertain"; this.status("editUncertain"); }
    finally { this.sending = false; this.persist(); this.render(); }
  }
}
